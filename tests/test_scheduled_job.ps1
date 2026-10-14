[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')).TrimEnd('\')
$testRoot = Join-Path $repo '.test-tmp\matt045-scheduled-job'
$sourceRepo = Join-Path $testRoot 'archive-source'
$installRoot = $testRoot
$clone = Join-Path $installRoot 'repo'
$bare = Join-Path $testRoot 'remote.git'
$fixture = Join-Path $testRoot 'refresh_hypedesk_test.ps1'
$advanceFixture = Join-Path $testRoot 'advance_hypedesk_test_remote.ps1'
$raceClone = Join-Path $testRoot 'race-clone'
$runner = Join-Path $repo 'ops\windows\run-hypedesk.ps1'
$installer = Join-Path $repo 'ops\windows\install-hypedesk.ps1'
$uninstaller = Join-Path $repo 'ops\windows\uninstall-hypedesk.ps1'
$python = 'C:\CryptoScope\tools\python-3.14\python.exe'
function Assert([bool]$Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
function Invoke-HdGit([string]$At, [string[]]$Args) {
    $gitExe = (Get-Command git -CommandType Application -ErrorAction Stop).Source
    $out = & $gitExe -c "safe.directory=$At" -C $At @Args 2>&1
    if ($LASTEXITCODE -ne 0) { throw "git $($Args -join ' ') failed: $($out -join ' ')" }
    return @($out | ForEach-Object { [string]$_ })
}
if (Test-Path -LiteralPath $testRoot) {
    $safe = [IO.Path]::GetFullPath($testRoot)
    if (-not $safe.StartsWith([IO.Path]::GetFullPath((Join-Path $repo '.test-tmp')) + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe test cleanup path.' }
    Remove-Item -LiteralPath $safe -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $testRoot | Out-Null
try {
$gitExe = (Get-Command git -CommandType Application -ErrorAction Stop).Source
$archiveEntries = Get-ChildItem -LiteralPath $repo -Force | Where-Object { $_.Name -notin @('.git', '.test-tmp') }
New-Item -ItemType Directory -Force -Path $sourceRepo | Out-Null
foreach ($entry in $archiveEntries) { Copy-Item -LiteralPath $entry.FullName -Destination $sourceRepo -Recurse -Force }
& $gitExe init $sourceRepo 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Could not initialize disposable Git source from the clean archive.' }
& $gitExe -C $sourceRepo add -A 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Could not stage clean archive in disposable Git source.' }
& $gitExe -C $sourceRepo -c user.name='HypeDesk archive test' -c user.email='archive-test@example.invalid' commit -m 'Initialize clean archive source' 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Could not commit disposable Git source from clean archive.' }
$fixtureText = @'
param([string]$RepoPath)
$stamp = [DateTime]::UtcNow.ToString('o')
$social = @{schema_version='social-context.v2'; status='READY'; captured_at_utc=$stamp; research_only=$true; trade_authorization=$false; execution_allowed=$false; source_health=@{}; items=@()}
$market = @{schema_version='market-opportunities.v1'; status='READY'; generated_at_utc=$stamp; market_data_captured_at_utc=$stamp; market_data_source='Fixture'; research_only=$true; trade_authorization=$false; execution_allowed=$false; candidates=@(); social_context=@{schema_version='social-context.v2'}}
$social | ConvertTo-Json -Depth 8 -Compress | Set-Content -LiteralPath (Join-Path $RepoPath 'data\social-context-v2-latest.json') -Encoding UTF8
$market | ConvertTo-Json -Depth 8 -Compress | Set-Content -LiteralPath (Join-Path $RepoPath 'data\market-opportunities-hourly-latest.json') -Encoding UTF8
'@
    Set-Content -LiteralPath $fixture -Value $fixtureText -Encoding UTF8
    $advanceText = @'
param([string]$RemoteClonePath)
$ErrorActionPreference = 'Stop'
$old = '2020-01-01T00:00:00Z'
$social = @{schema_version='social-context.v2'; status='READY'; captured_at_utc=$old; research_only=$true; trade_authorization=$false; execution_allowed=$false; source_health=@{}; items=@()}
$market = @{schema_version='market-opportunities.v1'; status='READY'; generated_at_utc=$old; market_data_captured_at_utc=$old; market_data_source='Race fixture'; research_only=$true; trade_authorization=$false; execution_allowed=$false; candidates=@(); social_context=@{schema_version='social-context.v2'}}
$social | ConvertTo-Json -Depth 8 -Compress | Set-Content -LiteralPath (Join-Path $RemoteClonePath 'data\social-context-v2-latest.json') -Encoding UTF8
$market | ConvertTo-Json -Depth 8 -Compress | Set-Content -LiteralPath (Join-Path $RemoteClonePath 'data\market-opportunities-hourly-latest.json') -Encoding UTF8
& git -C $RemoteClonePath add -- data/market-opportunities-hourly-latest.json data/social-context-v2-latest.json
if ($LASTEXITCODE -ne 0) { exit 1 }
& git -C $RemoteClonePath -c user.name='Race fixture' -c user.email='race-fixture@example.invalid' commit -m 'Simulate manual dispatch race' 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) { exit 1 }
& git -C $RemoteClonePath push origin main 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) { exit 1 }
'@
    Set-Content -LiteralPath $advanceFixture -Value $advanceText -Encoding UTF8
    $parseErrors = @()
    foreach ($path in @($runner, $installer, $uninstaller, $PSCommandPath)) {
        $tokens = $null; $errors = $null
        [void][System.Management.Automation.Language.Parser]::ParseFile($path, [ref]$tokens, [ref]$errors)
        $parseErrors += $errors
    }
    Assert ($parseErrors.Count -eq 0) "PowerShell parser errors: $($parseErrors | Out-String)"
    Assert (Test-Path -LiteralPath $python -PathType Leaf) 'Fixed production interpreter is unavailable; dry-run cannot prove preflight.'

    & $gitExe init --bare $bare 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Could not create local bare test remote.' }
    & $gitExe -c "safe.directory=$sourceRepo" clone --local $sourceRepo $clone 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Could not create disposable clone.' }
    Invoke-HdGit $clone @('remote', 'set-url', 'origin', $bare) | Out-Null
    Invoke-HdGit $clone @('checkout', '-B', 'main') | Out-Null
    Invoke-HdGit $clone @('config', 'user.name', 'HypeDesk test') | Out-Null
    Invoke-HdGit $clone @('config', 'user.email', 'hypedesk-test@example.invalid') | Out-Null
    New-Item -ItemType Directory -Force -Path (Join-Path $clone 'ops\windows') | Out-Null
    foreach ($scriptName in @('install-hypedesk.ps1', 'uninstall-hypedesk.ps1', 'run-hypedesk.ps1')) {
        Copy-Item -LiteralPath (Join-Path $repo "ops\windows\$scriptName") -Destination (Join-Path $clone "ops\windows\$scriptName") -Force
    }
    Invoke-HdGit $clone @('push', '-u', 'origin', 'main') | Out-Null
    Invoke-HdGit $clone @('add', 'ops/windows/install-hypedesk.ps1', 'ops/windows/uninstall-hypedesk.ps1', 'ops/windows/run-hypedesk.ps1') | Out-Null
    Invoke-HdGit $clone @('commit', '-m', 'Seed disposable publisher test') | Out-Null
    Invoke-HdGit $clone @('push', 'origin', 'main') | Out-Null
    & $gitExe clone $bare $raceClone 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Could not create race simulator clone.' }
    Invoke-HdGit $raceClone @('config', 'user.name', 'Race fixture') | Out-Null
    Invoke-HdGit $raceClone @('config', 'user.email', 'race-fixture@example.invalid') | Out-Null
    $remoteBefore = (& $gitExe --git-dir=$bare rev-parse refs/heads/main).Trim()
    if ($LASTEXITCODE -ne 0) { throw 'Could not read initial test remote ref.' }

    $state = Join-Path $installRoot 'state'
    New-Item -ItemType Directory -Force -Path $state | Out-Null
    $inventoryPath = Join-Path $state 'mock-task-inventory.json'
    @(@{TaskName='Unrelated-Test-Task'; Marker='keep-me'}) | ConvertTo-Json | Set-Content -LiteralPath $inventoryPath -Encoding UTF8
    Invoke-HdGit $clone @('remote', 'set-url', 'origin', 'https://github.com/attacker/not-market-attention.git') | Out-Null
    $wrongOriginInstall = & powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $installer -InstallRoot $installRoot -TestMode 2>&1
    Assert ($LASTEXITCODE -ne 0) 'Installer accepted an origin outside the disposable test root.'
    Invoke-HdGit $clone @('remote', 'set-url', 'origin', $bare) | Out-Null
    $installOutput = & powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $installer -InstallRoot $installRoot -TestMode 2>&1
    Assert ($LASTEXITCODE -eq 0) "Mock installer failed: $($installOutput -join ' ')"
    $inventory = @(Get-Content -LiteralPath $inventoryPath -Raw | ConvertFrom-Json)
    Assert (@($inventory | Where-Object TaskName -eq 'Unrelated-Test-Task').Count -eq 1) 'Installer did not preserve the unrelated mocked task.'
    Assert (@($inventory | Where-Object TaskName -eq 'MarketAttention-HypeDesk-Hourly').Count -eq 1) 'Installer did not register exactly its mocked task.'

    Invoke-HdGit $clone @('remote', 'set-url', 'origin', 'https://github.com/attacker/not-market-attention.git') | Out-Null
    $wrongOriginRun = & powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $runner -InstallRoot $installRoot -TestMode -DryRun -PythonPath $python -TestRefreshScript $fixture 2>&1
    Assert ($LASTEXITCODE -ne 0) 'Runner accepted an origin outside the disposable test root.'
    Invoke-HdGit $clone @('remote', 'set-url', 'origin', $bare) | Out-Null
    $runOutput = & powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $runner -InstallRoot $installRoot -TestMode -DryRun -PythonPath $python -TestRefreshScript $fixture 2>&1
    Assert ($LASTEXITCODE -eq 0) "Scheduled dry run failed: $($runOutput -join ' ')"
    Assert (($runOutput -join "`n") -match 'remote unchanged;') 'Dry run did not explicitly report the remote unchanged.'
    $remoteAfter = (& $gitExe --git-dir=$bare rev-parse refs/heads/main).Trim()
    Assert ($remoteAfter -eq $remoteBefore) 'Dry run changed the bare remote ref.'
    $localHead = (Invoke-HdGit $clone @('rev-parse', 'HEAD') | Select-Object -First 1).Trim()
    Assert ($localHead -ne $remoteBefore) 'Dry run did not prepare a local commit.'
    $paths = @(Invoke-HdGit $clone @('show', '--pretty=format:', '--name-only', 'HEAD') | Where-Object { $_ -ne '' } | Sort-Object -Unique)
    $expected = @('data/market-opportunities-hourly-latest.json', 'data/social-context-v2-latest.json')
    Assert (($paths -join '|') -eq (($expected | Sort-Object) -join '|')) "Dry-run commit paths differ from exact allowlist: $($paths -join ', ')"
    $status = Get-Content -LiteralPath (Join-Path $installRoot 'state\last-run.json') -Raw | ConvertFrom-Json
    Assert ($status.state -eq 'DRY_RUN_REMOTE_UNCHANGED') "Unexpected dry-run state $($status.state)."
    Assert ($status.remote_ref -eq $remoteBefore) 'Status does not record the unchanged remote ref.'
    Assert ($status.local_commit -eq $localHead) 'Status does not record the prepared local commit.'

    $publishOutput = & powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $runner -InstallRoot $installRoot -TestMode -PythonPath $python -TestRefreshScript $fixture -TestRemoteAdvanceScript $advanceFixture -TestRemoteClonePath $raceClone 2>&1
    Assert ($LASTEXITCODE -eq 0) "Capture-time non-fast-forward recovery failed: $($publishOutput -join ' ')"
    Assert (($publishOutput -join "`n") -match 'PUSH_REJECTED') 'Test did not observe the simulated non-fast-forward recovery.'
    Assert (($publishOutput -join "`n") -match 'PUBLISHED remote ref verified') 'Recovered publication did not verify the remote ref.'
    $publishedRemote = (& $gitExe --git-dir=$bare rev-parse refs/heads/main).Trim()
    $publishedLocal = (Invoke-HdGit $clone @('rev-parse', 'HEAD') | Select-Object -First 1).Trim()
    Assert ($publishedRemote -eq $publishedLocal) 'Recovered run did not publish the exact local commit.'
    Assert ($publishedRemote -ne $remoteBefore) 'Recovered run did not advance the disposable remote.'
    $publishedPaths = @(Invoke-HdGit $clone @('show', '--pretty=format:', '--name-only', 'HEAD') | Where-Object { $_ -ne '' } | Sort-Object -Unique)
    Assert (($publishedPaths -join '|') -eq (($expected | Sort-Object) -join '|')) "Recovery commit paths differ from allowlist: $($publishedPaths -join ', ')"
    $publishedStatus = Get-Content -LiteralPath (Join-Path $installRoot 'state\last-run.json') -Raw | ConvertFrom-Json
    Assert ($publishedStatus.state -eq 'PUBLISHED') 'Successful test publish did not report PUBLISHED.'
    Assert ($publishedStatus.remote_ref -eq $publishedRemote) 'Published status does not report the verified remote ref.'

    $lock = Join-Path $installRoot 'state\publisher.lock'
    $lockHandle = [IO.File]::Open($lock, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    $lockOutput = & powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $runner -InstallRoot $installRoot -TestMode -DryRun -PythonPath $python -TestRefreshScript $fixture 2>&1
    $lockHandle.Dispose()
    Assert ($LASTEXITCODE -eq 0) "Locked invocation should skip cleanly: $($lockOutput -join ' ')"
    Assert (($lockOutput -join "`n") -match 'SKIPPED_LOCKED') 'Overlap was not reported as skipped.'
    Remove-Item -LiteralPath $lock -Force

    $uninstallOutput = & powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $uninstaller -InstallRoot $installRoot -TestMode 2>&1
    Assert ($LASTEXITCODE -eq 0) "Mock uninstaller failed: $($uninstallOutput -join ' ')"
    $inventory = @(Get-Content -LiteralPath $inventoryPath -Raw | ConvertFrom-Json)
    Assert (@($inventory | Where-Object TaskName -eq 'Unrelated-Test-Task').Count -eq 1) 'Uninstaller removed/changed the unrelated mocked task.'
    Assert (@($inventory | Where-Object TaskName -eq 'MarketAttention-HypeDesk-Hourly').Count -eq 0) 'Uninstaller left its mocked task behind.'

    [pscustomobject]@{ result='PASS'; powershell=$PSVersionTable.PSVersion.ToString(); dry_run_remote_before=$remoteBefore; dry_run_remote_after=$remoteAfter; local_dry_run_commit=$localHead; dry_run_commit_paths=$paths; recovered_remote_ref=$publishedRemote; recovered_commit_paths=$publishedPaths; task_inventory='mocked; unrelated task preserved'; lock='overlap skipped'; dry_run='DRY_RUN_REMOTE_UNCHANGED'; nff='capture-time reapply and verified push' } | ConvertTo-Json -Depth 5
} finally {
    if (Test-Path -LiteralPath $testRoot) {
        $safe = [IO.Path]::GetFullPath($testRoot)
        if ($safe.StartsWith([IO.Path]::GetFullPath((Join-Path $repo '.test-tmp')) + '\', [StringComparison]::OrdinalIgnoreCase)) { Remove-Item -LiteralPath $safe -Recurse -Force }
    }
}
