[CmdletBinding()]
param(
    [string]$InstallRoot = 'C:\HypeDesk',
    [switch]$ConfirmPersistentInstall,
    [switch]$TestMode
)
$ErrorActionPreference = 'Stop'
$nativeModule = Join-Path $PSScriptRoot 'HypeDesk.Native.psm1'
Import-Module -Name $nativeModule -Force -ErrorAction Stop
$TaskName = 'MarketAttention-HypeDesk-Hourly'

function Resolve-GitExecutable([object[]]$Candidates = $null) {
    if ($null -eq $Candidates) { $Candidates = @(Get-Command git -CommandType Application -ErrorAction SilentlyContinue) }
    if (-not $Candidates -or $Candidates.Count -eq 0) { throw 'Git executable was not found.' }
    $commands = @($Candidates | Where-Object { $_.Source })
    if ($commands.Count -eq 0) { throw 'Git executable was not found.' }
    $preferred = @($commands | Where-Object { ([string]$_.Source) -match '(?i)\\cmd\\git\.exe$' } | Select-Object -First 1)
    if ($preferred.Count -gt 0) { return [string]$preferred[0].Source }
    return [string]$commands[0].Source
}

$resolvedRoot = [IO.Path]::GetFullPath($InstallRoot).TrimEnd('\')
$scriptRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..')).TrimEnd('\')
$testMarker = '\.test-tmp'
$testMarkerIndex = $scriptRoot.IndexOf($testMarker, [StringComparison]::OrdinalIgnoreCase)
if ($testMarkerIndex -ge 0) { $testRoot = $scriptRoot.Substring(0, $testMarkerIndex + $testMarker.Length) }
else { $testRoot = Join-Path $scriptRoot '.test-tmp' }
$testRoot = [IO.Path]::GetFullPath($testRoot).TrimEnd('\')
if ($TestMode) {
    if (($resolvedRoot -ne $testRoot) -and -not $resolvedRoot.StartsWith($testRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'TestMode root must be under repo/.test-tmp.' }
} else {
    if (-not $ConfirmPersistentInstall) { throw 'Persistent Task Scheduler registration is gated. Claude must obtain Ray confirmation and pass -ConfirmPersistentInstall.' }
    if ($resolvedRoot -ne 'C:\HypeDesk') { throw 'Production install root is fixed at C:\HypeDesk.' }
}
$repo = Join-Path $resolvedRoot 'repo'
$gitExe = Resolve-GitExecutable
$runner = Join-Path $repo 'ops\windows\run-hypedesk.ps1'
if (-not (Test-Path -LiteralPath $runner -PathType Leaf)) { throw "Publisher runner missing: $runner" }
$gitRootResult = Invoke-Native -FilePath $gitExe -ArgumentList @('-C', $repo, 'rev-parse', '--show-toplevel') -WorkingDirectory $repo
if ($gitRootResult.ExitCode -ne 0 -or [IO.Path]::GetFullPath([string]$gitRootResult.StdOut.Trim()).TrimEnd('\') -ne [IO.Path]::GetFullPath($repo).TrimEnd('\')) { throw "Configured repo is not the clone root (exit $($gitRootResult.ExitCode))." }
$fetchResult = Invoke-Native -FilePath $gitExe -ArgumentList @('-C', $repo, 'remote', 'get-url', '--all', 'origin') -WorkingDirectory $repo
$fetchUrls = @($fetchResult.StdOut -split "`r?`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ })
$pushResult = Invoke-Native -FilePath $gitExe -ArgumentList @('-C', $repo, 'remote', 'get-url', '--push', '--all', 'origin') -WorkingDirectory $repo
$pushUrls = @($pushResult.StdOut -split "`r?`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ })
$pushConfigResult = Invoke-Native -FilePath $gitExe -ArgumentList @('-C', $repo, 'config', '--get-all', 'remote.origin.pushurl') -WorkingDirectory $repo
$configuredPushUrls = @($pushConfigResult.StdOut -split "`r?`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ })
$fetchCode = $fetchResult.ExitCode
$pushCode = $pushResult.ExitCode
$pushConfigCode = $pushConfigResult.ExitCode
$originPattern = '^https://github\.com/raydan01/crypto-hourly-desk(?:\.git)?$'
if ($fetchCode -ne 0 -or $pushCode -ne 0 -or $pushConfigCode -gt 1 -or $fetchUrls.Count -eq 0 -or $pushUrls.Count -eq 0) { throw 'Configured repository fetch and push URLs could not be validated.' }
if ($TestMode) {
    foreach ($remoteUrl in @($fetchUrls) + @($pushUrls) + @($configuredPushUrls)) {
        try { $testOrigin = [IO.Path]::GetFullPath($remoteUrl) } catch { throw 'TestMode remotes must use one existing disposable remote under repo/.test-tmp.' }
        if (-not $testOrigin.StartsWith($testRoot + '\', [StringComparison]::OrdinalIgnoreCase) -or -not (Test-Path -LiteralPath $testOrigin -PathType Container)) { throw 'TestMode remotes must use one existing disposable remote under repo/.test-tmp.' }
    }
    if (($fetchUrls | Select-Object -Unique).Count -ne 1 -or ($pushUrls | Select-Object -Unique).Count -ne 1 -or $fetchUrls[0] -ne $pushUrls[0]) { throw 'TestMode fetch and push URLs must match.' }
} elseif (@($fetchUrls + $pushUrls + $configuredPushUrls | Where-Object { $_ -notmatch $originPattern }).Count -gt 0 -or ($fetchUrls | Select-Object -Unique).Count -ne 1 -or ($pushUrls | Select-Object -Unique).Count -ne 1) {
    throw 'Configured repository fetch or push URL does not match the approved Market Attention repository.'
}

if ($TestMode) {
    $inventoryPath = Join-Path $resolvedRoot 'state\mock-task-inventory.json'
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $inventoryPath) | Out-Null
    if (Test-Path -LiteralPath $inventoryPath) { $inventory = @(foreach ($hdItem in (Get-Content -LiteralPath $inventoryPath -Raw | ConvertFrom-Json)) { $hdItem }) } else { $inventory = @() }
    $others = @($inventory | Where-Object { $_.TaskName -ne $TaskName })
    $mine = [pscustomobject]@{ TaskName=$TaskName; UserId=[Security.Principal.WindowsIdentity]::GetCurrent().Name; LogonType='Interactive'; Schedule='Hourly'; MultipleInstances='IgnoreNew'; NetworkAvailable=$true; RunLevel='LeastPrivilege'; Action=$runner; LastTaskResult='NotRun'; NextRunTime=[DateTime]::Now.AddMinutes(2).ToString('o') }
    $inventoryJson = ConvertTo-Json -InputObject @($others + $mine) -Depth 5
    [IO.File]::WriteAllText($inventoryPath, $inventoryJson, (New-Object System.Text.UTF8Encoding($false)))
    $task = $mine
} else {
    Import-Module ScheduledTasks -ErrorAction Stop
    $user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    $action = New-ScheduledTaskAction -Execute (Join-Path $PSHOME 'powershell.exe') -Argument "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$runner`""
    $now = Get-Date
    $next = $now.Date.AddHours($now.Hour).AddMinutes(17)
    if ($next -le $now) { $next = $next.AddHours(1) }
    $trigger = New-ScheduledTaskTrigger -Daily -At $next
    $trigger.Repetition = (New-ScheduledTaskTrigger -Once -At $next -RepetitionInterval (New-TimeSpan -Hours 1) -RepetitionDuration (New-TimeSpan -Hours 23)).Repetition
    $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -RunOnlyIfNetworkAvailable -MultipleInstances IgnoreNew -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero)
    $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($existing) { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false }
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Publishes the two public Market Attention artifacts hourly.' | Out-Null
    $task = Get-ScheduledTask -TaskName $TaskName
    $info = Get-ScheduledTaskInfo -TaskName $TaskName
    $task | Add-Member -NotePropertyName LastTaskResult -NotePropertyValue $info.LastTaskResult -Force
    $task | Add-Member -NotePropertyName NextRunTime -NotePropertyValue $info.NextRunTime -Force
}
if ($TestMode) {
    'Task registration: MOCKED'; "Task: $($task.TaskName)"; "User: $($task.UserId)"; "Logon: $($task.LogonType)"; "Schedule: $($task.Schedule)"; "Last result: $($task.LastTaskResult)"; "Next run: $($task.NextRunTime)"
} else {
    'Task registration: verified'; "Task: $($task.TaskName)"; "Last result: $($task.LastTaskResult)"; "Next run: $($task.NextRunTime)"
}
