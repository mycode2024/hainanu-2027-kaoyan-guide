function Remove-OldLogPairs {
    param(
        [Parameter(Mandatory = $true)]
        [string]$DataDirectory,
        [ValidateRange(0, 14)]
        [int]$Keep = 14
    )

    $logFiles = Get-ChildItem -LiteralPath $DataDirectory -File -ErrorAction Stop |
        Where-Object { $_.Name -match '^server-.*\.log$' }
    if (-not $logFiles) { return }

    $groups = $logFiles | ForEach-Object {
        $isErrorLog = $_.Name -like '*.error.log'
        [PSCustomObject]@{
            Base = if ($isErrorLog) { $_.Name.Substring(0, $_.Name.Length - '.error.log'.Length) } else { $_.BaseName }
            LastWriteTimeUtc = $_.LastWriteTimeUtc
            Path = $_.FullName
        }
    } | Group-Object Base | ForEach-Object {
        [PSCustomObject]@{
            Base = $_.Name
            LastWriteTimeUtc = ($_.Group | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1).LastWriteTimeUtc
            Paths = @($_.Group.Path)
        }
    } | Sort-Object -Property @{ Expression = 'LastWriteTimeUtc'; Descending = $true }, @{ Expression = 'Base'; Descending = $true } |
        Select-Object -Skip $Keep

    foreach ($group in $groups) {
        foreach ($filePath in $group.Paths) {
            Remove-Item -LiteralPath $filePath -Force
        }
    }
}
