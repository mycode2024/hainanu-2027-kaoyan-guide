param(
    [ValidateRange(1, 65535)]
    [int]$Port = 4173
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$pidFileName = if ($Port -eq 4173) { 'server.pid' } else { "server-$Port.pid" }
$pidPath = Join-Path $projectRoot "data\$pidFileName"
$serverScript = Join-Path $projectRoot 'server.cjs'
$healthUrl = "http://127.0.0.1:$Port/api/health"

function Test-GuideLive {
    $request = [System.Net.HttpWebRequest]::Create($healthUrl)
    $request.Method = 'GET'
    $request.Timeout = 1000
    $request.ReadWriteTimeout = 1000
    $response = $null
    $reader = $null
    try {
        $response = $request.GetResponse()
        $reader = New-Object System.IO.StreamReader($response.GetResponseStream())
        $health = ($reader.ReadToEnd() | ConvertFrom-Json)
        return $health.product -eq 'hainanu-2027-kaoyan-guide' -and
            $health.schemaVersion -eq 2 -and
            $health.live -eq $true
    } catch {
        return $false
    } finally {
        if ($null -ne $reader) { $reader.Dispose() }
        if ($null -ne $response) { $response.Dispose() }
    }
}

function Remove-PidIfOwned {
    param([int]$ProcessId)

    if (-not (Test-Path -LiteralPath $pidPath)) { return }
    $currentPid = (Get-Content -LiteralPath $pidPath -Raw -ErrorAction Stop).Trim()
    if ($currentPid -eq [string]$ProcessId) {
        Remove-Item -LiteralPath $pidPath -Force -ErrorAction Stop
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

function ConvertFrom-WindowsCommandLine {
    param([string]$CommandLine)

    if (-not ('HainanuNativeCommandLine' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class HainanuNativeCommandLine
{
    [DllImport("shell32.dll", SetLastError = true)]
    public static extern IntPtr CommandLineToArgvW(
        [MarshalAs(UnmanagedType.LPWStr)] string commandLine,
        out int argumentCount);

    [DllImport("kernel32.dll")]
    public static extern IntPtr LocalFree(IntPtr memory);
}
'@
    }

    $argumentCount = 0
    $argumentPointer = [HainanuNativeCommandLine]::CommandLineToArgvW($CommandLine, [ref]$argumentCount)
    if ($argumentPointer -eq [IntPtr]::Zero) {
        throw (New-Object ComponentModel.Win32Exception([Runtime.InteropServices.Marshal]::GetLastWin32Error()))
    }

    try {
        for ($index = 0; $index -lt $argumentCount; $index += 1) {
            $stringPointer = [Runtime.InteropServices.Marshal]::ReadIntPtr(
                $argumentPointer,
                $index * [IntPtr]::Size
            )
            [Runtime.InteropServices.Marshal]::PtrToStringUni($stringPointer)
        }
    } finally {
        [void][HainanuNativeCommandLine]::LocalFree($argumentPointer)
    }
}

function ConvertTo-CreationTimeIdentity {
    param($CreationDate)

    if ($null -eq $CreationDate -or [string]::IsNullOrWhiteSpace([string]$CreationDate)) {
        return $null
    }
    if ($CreationDate -is [DateTime]) {
        return $CreationDate.ToUniversalTime().ToString('o', [Globalization.CultureInfo]::InvariantCulture)
    }
    return [string]$CreationDate
}

try {
    $lifecycleMutex = New-Object System.Threading.Mutex($false, (Get-LifecycleMutexName))
} catch {
    throw "Could not create the required Global lifecycle mutex. No process was stopped: $($_.Exception.Message)"
}
$ownsLifecycleMutex = $false
try {
    try {
        $ownsLifecycleMutex = $lifecycleMutex.WaitOne(30000)
    } catch [System.Threading.AbandonedMutexException] {
        $ownsLifecycleMutex = $true
    }
    if (-not $ownsLifecycleMutex) {
        throw 'Timed out waiting for another guide lifecycle operation. No process was stopped.'
    }

    if (-not (Test-Path -LiteralPath $pidPath)) {
        Write-Host 'No launcher-managed service process was found.'
        return
    }

$processIdText = (Get-Content -LiteralPath $pidPath -Raw).Trim()
$processIdValue = 0
if (-not [int]::TryParse($processIdText, [ref]$processIdValue)) {
    throw 'The PID file is invalid. No process was stopped, and the PID file was kept.'
}

try {
    $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $processIdValue" -ErrorAction Stop
} catch {
    throw "Could not query PID $processIdValue. No process was stopped, and the PID file was kept: $($_.Exception.Message)"
}

    if ($null -eq $processInfo) {
        if (Test-GuideLive) {
            throw 'The recorded process is absent, but the guide is still live. The PID file was kept.'
        }
        Remove-PidIfOwned -ProcessId $processIdValue
        Write-Host 'The service is already stopped; the stale PID file was removed.'
        return
    }

$isExpectedNode = $processInfo.Name -match '^node(?:\.exe)?$'
try {
    $processArguments = if ($processInfo.CommandLine) {
        @(ConvertFrom-WindowsCommandLine -CommandLine $processInfo.CommandLine)
    } else {
        @()
    }
} catch {
    throw "Could not verify PID $processIdValue command-line ownership. No process was stopped, and the PID file was kept: $($_.Exception.Message)"
}
$isExpectedScript = $processArguments.Count -ge 2 -and
    [string]::Equals($processArguments[1], $serverScript, [StringComparison]::OrdinalIgnoreCase)
if (-not ($isExpectedNode -and $isExpectedScript)) {
    throw 'The PID belongs to another process. No process was stopped, and the PID file was kept.'
}
$initialCreationTime = ConvertTo-CreationTimeIdentity -CreationDate $processInfo.CreationDate
if ($null -eq $initialCreationTime) {
    throw 'Could not verify PID creation time ownership. No process was stopped, and the PID file was kept.'
}
$initialName = [string]$processInfo.Name
$initialServerArgument = [string]$processArguments[1]

$processHandle = $null
$nativeProcessHandle = $null
try {
    try {
        $processHandle = [System.Diagnostics.Process]::GetProcessById($processIdValue)
        $nativeProcessHandle = $processHandle.SafeHandle
        if ($null -eq $nativeProcessHandle -or $nativeProcessHandle.IsInvalid -or $nativeProcessHandle.IsClosed) {
            throw 'the native process handle is invalid'
        }
        [void]$processHandle.Handle
    } catch {
        throw "Could not open a native handle for PID $processIdValue. No process was stopped, and the PID file was kept: $($_.Exception.Message)"
    }

    try {
        $processInfoBeforeTermination = Get-CimInstance Win32_Process -Filter "ProcessId = $processIdValue" -ErrorAction Stop
    } catch {
        throw "Could not re-query PID $processIdValue before termination. No process was stopped, and the PID file was kept: $($_.Exception.Message)"
    }
    if ($null -eq $processInfoBeforeTermination -or
        [string]::IsNullOrWhiteSpace([string]$processInfoBeforeTermination.Name) -or
        [string]::IsNullOrWhiteSpace([string]$processInfoBeforeTermination.CommandLine)) {
        throw 'The PID identity could not be fully re-verified before termination. No process was stopped, and the PID file was kept.'
    }
    try {
        $recheckedArguments = @(ConvertFrom-WindowsCommandLine -CommandLine $processInfoBeforeTermination.CommandLine)
    } catch {
        throw "Could not re-verify PID $processIdValue command-line ownership. No process was stopped, and the PID file was kept: $($_.Exception.Message)"
    }
    $recheckedCreationTime = ConvertTo-CreationTimeIdentity -CreationDate $processInfoBeforeTermination.CreationDate
    $sameProcessId = $processInfoBeforeTermination.ProcessId -eq $processIdValue
    $sameNodeName = [string]::Equals($processInfoBeforeTermination.Name, $initialName, [StringComparison]::OrdinalIgnoreCase)
    $sameServerScript = $recheckedArguments.Count -ge 2 -and
        [string]::Equals($recheckedArguments[1], $serverScript, [StringComparison]::OrdinalIgnoreCase) -and
        [string]::Equals($recheckedArguments[1], $initialServerArgument, [StringComparison]::OrdinalIgnoreCase)
    $sameCreationTime = $null -ne $recheckedCreationTime -and
        [string]::Equals($recheckedCreationTime, $initialCreationTime, [StringComparison]::Ordinal)
    if (-not ($sameProcessId -and $sameNodeName -and $sameServerScript -and $sameCreationTime)) {
        throw 'The PID identity changed or could not be fully verified before termination. No process was stopped, and the PID file was kept.'
    }
    try {
        $processHandle.Kill()
    } catch {
        throw "Could not terminate PID $processIdValue through its native process handle. The PID file was kept: $($_.Exception.Message)"
    }

    if (-not $processHandle.WaitForExit(10000)) {
        throw "PID $processIdValue did not exit within 10 seconds. The PID file was kept."
    }
} finally {
    if ($null -ne $processHandle) { $processHandle.Dispose() }
}

if (Test-GuideLive) {
    throw 'The managed process exited, but the guide is still live. The PID file was kept.'
}

    Remove-PidIfOwned -ProcessId $processIdValue
    Write-Host 'The Hainan University 2027 guide service has stopped.'
} finally {
    if ($ownsLifecycleMutex) { $lifecycleMutex.ReleaseMutex() }
    $lifecycleMutex.Dispose()
}
