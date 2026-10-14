Set-StrictMode -Version 2

function ConvertTo-NativeArgument([string]$Value) {
    if ($null -eq $Value) { $Value = '' }
    if ($Value.Length -gt 0 -and $Value -notmatch '[\s"]') { return $Value }
    $builder = New-Object System.Text.StringBuilder
    [void]$builder.Append('"')
    $slashes = 0
    foreach ($character in $Value.ToCharArray()) {
        if ($character -eq '\') { $slashes++; continue }
        if ($character -eq '"') {
            [void]$builder.Append(('\' * (($slashes * 2) + 1)))
            [void]$builder.Append('"')
            $slashes = 0
            continue
        }
        if ($slashes -gt 0) { [void]$builder.Append(('\' * $slashes)); $slashes = 0 }
        [void]$builder.Append($character)
    }
    if ($slashes -gt 0) { [void]$builder.Append(('\' * ($slashes * 2))) }
    [void]$builder.Append('"')
    return $builder.ToString()
}

function Invoke-Native {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory=$true)][string]$FilePath,
        [Parameter(Mandatory=$true)][string[]]$ArgumentList,
        [string]$WorkingDirectory,
        [ValidateRange(1, 86400)][int]$TimeoutSeconds = 300
    )
    $start = New-Object System.Diagnostics.ProcessStartInfo
    $start.FileName = $FilePath
    $start.Arguments = (($ArgumentList | ForEach-Object { ConvertTo-NativeArgument ([string]$_) }) -join ' ')
    $start.UseShellExecute = $false
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $start.CreateNoWindow = $true
    if ($WorkingDirectory) { $start.WorkingDirectory = $WorkingDirectory }
    if ([IO.Path]::GetFileName($FilePath) -match '^(?i:git)(\.exe)?$') {
        $start.EnvironmentVariables['GIT_TERMINAL_PROMPT'] = '0'
        $start.EnvironmentVariables['GCM_INTERACTIVE'] = 'never'
    }
    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $start
    try {
        if (-not $process.Start()) { throw "Could not start native program: $FilePath" }
        $stdoutTask = $process.StandardOutput.ReadToEndAsync()
        $stderrTask = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
            try { $process.Kill(); $process.WaitForExit() } catch { }
            [void]$stdoutTask.Result
            [void]$stderrTask.Result
            throw "Native program timed out after $TimeoutSeconds seconds: $FilePath"
        }
        $process.WaitForExit()
        return [pscustomobject]@{
            ExitCode = [int]$process.ExitCode
            StdOut = [string]$stdoutTask.Result
            StdErr = [string]$stderrTask.Result
        }
    } finally {
        $process.Dispose()
    }
}

Export-ModuleMember -Function Invoke-Native
