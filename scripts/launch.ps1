param(
    [ValidateRange(1, 65535)]
    [int]$Port = 4173,
    [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$siteUrl = "http://127.0.0.1:$Port"
$healthUrl = "$siteUrl/api/health"
$pageMarker = 'data-product="hainanu-2027-kaoyan-guide"'
$dataDirectory = Join-Path $projectRoot 'data'
$pidFileName = if ($Port -eq 4173) { 'server.pid' } else { "server-$Port.pid" }
$pidPath = Join-Path $dataDirectory $pidFileName
$serverScript = Join-Path $projectRoot 'server.cjs'

function Invoke-TextProbe {
    param(
        [string]$Uri,
        [int]$TimeoutMilliseconds
    )

    $boundedTimeout = [Math]::Max(1, $TimeoutMilliseconds)
    $request = [System.Net.HttpWebRequest]::Create($Uri)
    $request.Method = 'GET'
    $request.Timeout = $boundedTimeout
    $request.ReadWriteTimeout = $boundedTimeout
    $response = $null
    $reader = $null
    try {
        $response = $request.GetResponse()
        $reader = New-Object System.IO.StreamReader($response.GetResponseStream())
        return $reader.ReadToEnd()
    } finally {
        if ($null -ne $reader) { $reader.Dispose() }
        if ($null -ne $response) { $response.Dispose() }
    }
}

function Test-GuideLive {
    param(
        [System.Diagnostics.Stopwatch]$Timer,
        [int]$BudgetMilliseconds
    )

    try {
        $remaining = $BudgetMilliseconds - [int]$Timer.ElapsedMilliseconds
        if ($remaining -le 0) { return $false }
        $healthText = Invoke-TextProbe -Uri $healthUrl -TimeoutMilliseconds ([Math]::Min(1000, $remaining))
        $health = $healthText | ConvertFrom-Json
        if ($health.product -ne 'hainanu-2027-kaoyan-guide' -or $health.schemaVersion -ne 2 -or $health.live -ne $true) {
            return $false
        }

        $remaining = $BudgetMilliseconds - [int]$Timer.ElapsedMilliseconds
        if ($remaining -le 0) { return $false }
        $pageText = Invoke-TextProbe -Uri $siteUrl -TimeoutMilliseconds ([Math]::Min(1000, $remaining))
        return $pageText.Contains($pageMarker)
    } catch {
        return $false
    }
}

function Get-LifecycleMutexName {
    $canonicalRoot = [System.IO.Path]::GetFullPath($projectRoot).TrimEnd('\').ToLowerInvariant()
    $mutexSeed = "$canonicalRoot|$Port"
    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    try {
        $hashBytes = $sha256.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($mutexSeed))
    } finally {
        $sha256.Dispose()
    }
    $hash = ([System.BitConverter]::ToString($hashBytes)).Replace('-', '')
    return "Global\HainanuGuide-$hash"
}

function Get-LogMutexName {
    $canonicalRoot = [System.IO.Path]::GetFullPath($projectRoot).TrimEnd('\').ToLowerInvariant()
    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    try {
        $hashBytes = $sha256.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($canonicalRoot))
    } finally {
        $sha256.Dispose()
    }
    $hash = ([System.BitConverter]::ToString($hashBytes)).Replace('-', '')
    return "Global\HainanuGuide-$hash-logs"
}

function Invoke-WithProjectLogMutex {
    param([scriptblock]$Action)

    try {
        $logMutex = New-Object System.Threading.Mutex($false, (Get-LogMutexName))
    } catch {
        throw "Could not create the required Global project log mutex: $($_.Exception.Message)"
    }
    $ownsLogMutex = $false
    try {
        try {
            $ownsLogMutex = $logMutex.WaitOne(30000)
        } catch [System.Threading.AbandonedMutexException] {
            $ownsLogMutex = $true
        }
        if (-not $ownsLogMutex) {
            throw 'Timed out waiting for another guide log operation to finish.'
        }
        return (& $Action)
    } finally {
        if ($ownsLogMutex) { $logMutex.ReleaseMutex() }
        $logMutex.Dispose()
    }
}

function Set-PidAtomically {
    param([int]$ProcessId)

    $temporaryPidPath = Join-Path $dataDirectory ("server.pid.{0}.tmp" -f [Guid]::NewGuid().ToString('N'))
    $backupPidPath = Join-Path $dataDirectory ("server.pid.{0}.bak" -f [Guid]::NewGuid().ToString('N'))
    try {
        [System.IO.File]::WriteAllText(
            $temporaryPidPath,
            "$ProcessId`r`n",
            [System.Text.Encoding]::ASCII
        )
        if (Test-Path -LiteralPath $pidPath) {
            if (-not (Test-Path -LiteralPath $pidPath -PathType Leaf)) {
                throw "The PID path is not a file: $pidPath"
            }
            [System.IO.File]::Replace($temporaryPidPath, $pidPath, $backupPidPath, $true)
        } else {
            [System.IO.File]::Move($temporaryPidPath, $pidPath)
        }
    } finally {
        Remove-Item -LiteralPath $temporaryPidPath -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $backupPidPath -Force -ErrorAction SilentlyContinue
    }
}

function Remove-PidIfOwned {
    param([int]$ProcessId)

    try {
        if (-not (Test-Path -LiteralPath $pidPath)) { return }
        $currentPid = (Get-Content -LiteralPath $pidPath -Raw -ErrorAction Stop).Trim()
        if ($currentPid -eq [string]$ProcessId) {
            Remove-Item -LiteralPath $pidPath -Force -ErrorAction Stop
        }
    } catch {
        Write-Warning "Could not clean the PID file safely: $($_.Exception.Message)"
    }
}

function Remove-OldLogPairs {
    param([ValidateRange(0, 14)][int]$Keep)

    $pairs = Get-ChildItem -LiteralPath $dataDirectory -File -Filter 'server-*.log' |
        Where-Object { $_.Name -notlike '*.error.log' } |
        ForEach-Object {
            $errorPath = Join-Path $dataDirectory ($_.BaseName + '.error.log')
            if (Test-Path -LiteralPath $errorPath) {
                [PSCustomObject]@{
                    Name = $_.Name
                    LastWriteTimeUtc = $_.LastWriteTimeUtc
                    StandardPath = $_.FullName
                    ErrorPath = $errorPath
                }
            }
        }

    $pairs |
        Sort-Object -Property @{ Expression = 'LastWriteTimeUtc'; Descending = $true }, @{ Expression = 'Name'; Descending = $true } |
        Select-Object -Skip $Keep |
        ForEach-Object {
            Remove-Item -LiteralPath $_.StandardPath -Force
            Remove-Item -LiteralPath $_.ErrorPath -Force
        }
}

$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCommand) {
    throw 'Node.js 18 or newer is required: https://nodejs.org/'
}
$nodeVersionText = node --version
if ($nodeVersionText -notmatch '^v(\d+)' -or [int]$Matches[1] -lt 18) {
    throw "Node.js 18 or newer is required; found: $nodeVersionText"
}

New-Item -ItemType Directory -Path $dataDirectory -Force | Out-Null

    try {
        $launchMutex = New-Object System.Threading.Mutex($false, (Get-LifecycleMutexName))
    } catch {
        throw "Could not create the required Global lifecycle mutex. No service was started: $($_.Exception.Message)"
    }
    $ownsLaunchMutex = $false
    try {
        try {
            $ownsLaunchMutex = $launchMutex.WaitOne(30000)
        } catch [System.Threading.AbandonedMutexException] {
            $ownsLaunchMutex = $true
        }
        if (-not $ownsLaunchMutex) {
            throw 'Timed out waiting for another guide launch to finish.'
        }

        Invoke-WithProjectLogMutex -Action { Remove-OldLogPairs -Keep 14 } | Out-Null
        $readinessBudgetMs = 15000
        $readinessTimer = [System.Diagnostics.Stopwatch]::StartNew()
        if (Test-GuideLive -Timer $readinessTimer -BudgetMilliseconds $readinessBudgetMs) {
            Write-Host "The guide service is already running: $siteUrl"
        } else {
            $nodePath = $nodeCommand.Source
            $serverArgument = '"' + $serverScript + '"'
            $serverProcess = $null
            $standardLog = $null
            $errorLog = $null
            try {
                $launchDetails = Invoke-WithProjectLogMutex -Action {
                    Remove-OldLogPairs -Keep 13
                    $timestamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
                    $launchNonce = [Guid]::NewGuid().ToString('N')
                    $allocatedStandardLog = Join-Path $dataDirectory "server-$Port-$timestamp-$launchNonce.log"
                    $allocatedErrorLog = Join-Path $dataDirectory "server-$Port-$timestamp-$launchNonce.error.log"
                    $inheritedPort = $env:PORT
                    try {
                        $env:PORT = [string]$Port
                        $allocatedProcess = Start-Process -FilePath $nodePath `
                            -ArgumentList $serverArgument `
                            -WorkingDirectory $projectRoot `
                            -WindowStyle Hidden `
                            -RedirectStandardOutput $allocatedStandardLog `
                            -RedirectStandardError $allocatedErrorLog `
                            -PassThru
                    } finally {
                        if ($null -eq $inheritedPort) {
                            Remove-Item Env:PORT -ErrorAction SilentlyContinue
                        } else {
                            $env:PORT = $inheritedPort
                        }
                    }
                    [PSCustomObject]@{
                        Process = $allocatedProcess
                        StandardLog = $allocatedStandardLog
                        ErrorLog = $allocatedErrorLog
                    }
                }
                $serverProcess = $launchDetails.Process
                $standardLog = $launchDetails.StandardLog
                $errorLog = $launchDetails.ErrorLog
                try {
                    Set-PidAtomically -ProcessId $serverProcess.Id
                } catch {
                    throw "Could not publish PID $($serverProcess.Id) atomically: $($_.Exception.Message)"
                }

                $ready = $false
                while ($readinessTimer.ElapsedMilliseconds -lt $readinessBudgetMs) {
                    if ($serverProcess.HasExited) { break }
                    if (Test-GuideLive -Timer $readinessTimer -BudgetMilliseconds $readinessBudgetMs) {
                        $ready = $true
                        break
                    }
                    $remaining = $readinessBudgetMs - [int]$readinessTimer.ElapsedMilliseconds
                    if ($remaining -gt 0) { Start-Sleep -Milliseconds ([Math]::Min(250, $remaining)) }
                    $serverProcess.Refresh()
                }

                if (-not $ready) {
                    $errorTail = if (Test-Path -LiteralPath $errorLog) {
                        (Get-Content -LiteralPath $errorLog -Tail 20) -join [Environment]::NewLine
                    } else { 'No error log was created.' }
                    throw "The service did not become ready within 15 seconds. Error log: $errorLog`n$errorTail"
                }

                Write-Host "The guide service is ready: $siteUrl"
                Write-Host "PID: $($serverProcess.Id); logs: $dataDirectory"
            } catch {
                $launchFailure = $_
                $cleanupFailure = $null
                $childExited = $false
                if ($null -ne $serverProcess) {
                    try {
                        $serverProcess.Refresh()
                        if (-not $serverProcess.HasExited) {
                            Stop-Process -Id $serverProcess.Id -Force -ErrorAction Stop
                        }
                        $serverProcess.Refresh()
                        if (-not $serverProcess.HasExited -and -not $serverProcess.WaitForExit(10000)) {
                            throw "PID $($serverProcess.Id) did not exit within 10 seconds."
                        }
                        $serverProcess.Refresh()
                        $childExited = $serverProcess.HasExited
                        if (-not $childExited) {
                            throw "PID $($serverProcess.Id) could not be confirmed exited after cleanup."
                        }
                    } catch {
                        $cleanupFailure = $_
                        try {
                            $serverProcess.Refresh()
                            $childExited = $serverProcess.HasExited
                        } catch {
                            $childExited = $false
                        }
                    }
                    if ($childExited) {
                        Remove-PidIfOwned -ProcessId $serverProcess.Id
                    }
                }
                if ($null -ne $cleanupFailure) {
                    if (-not $childExited) {
                        throw "$($launchFailure.Exception.Message) Child cleanup also failed: $($cleanupFailure.Exception.Message) PID file was kept because child PID $($serverProcess.Id) could not be confirmed exited."
                    }
                    throw "$($launchFailure.Exception.Message) Child cleanup also failed after child exit: $($cleanupFailure.Exception.Message)"
                }
                throw $launchFailure
            }
        }
    } finally {
        if ($ownsLaunchMutex) { $launchMutex.ReleaseMutex() }
        $launchMutex.Dispose()
    }

if (-not $NoBrowser) {
    try {
        Start-Process -FilePath $siteUrl -ErrorAction Stop | Out-Null
    } catch {
        Write-Warning "The service is ready, but the browser could not be opened: $($_.Exception.Message)"
    }
}
