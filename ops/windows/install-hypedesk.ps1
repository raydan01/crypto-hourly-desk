[CmdletBinding()]
param(
    [string]$InstallRoot = 'C:\HypeDesk',
    [switch]$ConfirmPersistentInstall,
    [switch]$TestMode
)
$ErrorActionPreference = 'Stop'
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
$gitRoot = & $gitExe -C $repo rev-parse --show-toplevel 2>$null
if ($LASTEXITCODE -ne 0 -or [IO.Path]::GetFullPath([string]$gitRoot).TrimEnd('\') -ne [IO.Path]::GetFullPath($repo).TrimEnd('\')) { throw 'Configured repo is not the clone root.' }
$fetchUrls = @(& $gitExe -C $repo remote get-url --all origin 2>$null | ForEach-Object { ([string]$_).Trim() } | Where-Object { $_ })
$fetchCode = $LASTEXITCODE
$pushUrls = @(& $gitExe -C $repo remote get-url --push --all origin 2>$null | ForEach-Object { ([string]$_).Trim() } | Where-Object { $_ })
$pushCode = $LASTEXITCODE
$configuredPushUrls = @(& $gitExe -C $repo config --get-all remote.origin.pushurl 2>$null | ForEach-Object { ([string]$_).Trim() } | Where-Object { $_ })
$pushConfigCode = $LASTEXITCODE
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
    if (Test-Path -LiteralPath $inventoryPath) { $inventory = @(Get-Content -LiteralPath $inventoryPath -Raw | ConvertFrom-Json) } else { $inventory = @() }
    $others = @($inventory | Where-Object { $_.TaskName -ne $TaskName })
    $mine = [pscustomobject]@{ TaskName=$TaskName; UserId=[Security.Principal.WindowsIdentity]::GetCurrent().Name; LogonType='Interactive'; Schedule='Hourly'; MultipleInstances='IgnoreNew'; NetworkAvailable=$true; RunLevel='LeastPrivilege'; Action=$runner; LastTaskResult='NotRun'; NextRunTime=[DateTime]::Now.AddMinutes(2).ToString('o') }
    @($others + $mine) | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $inventoryPath -Encoding UTF8
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
