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
$failureFixture = Join-Path $testRoot 'refresh_hypedesk_native_failure_test.ps1'
$advanceFixture = Join-Path $testRoot 'advance_hypedesk_test_remote.ps1'
$raceClone = Join-Path $testRoot 'race-clone'
$runner = Join-Path $repo 'ops\windows\run-hypedesk.ps1'
$installer = Join-Path $repo 'ops\windows\install-hypedesk.ps1'
$uninstaller = Join-Path $repo 'ops\windows\uninstall-hypedesk.ps1'
$nativeModule = Join-Path $repo 'ops\windows\HypeDesk.Native.psm1'
Import-Module -Name $nativeModule -Force -ErrorAction Stop
$python = 'C:\CryptoScope\tools\python-3.14\python.exe'
function Assert([bool]$Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
function Invoke-HdNative([string]$Path, [string[]]$NativeArgs, [string]$At, [int]$ExpectedExit = 0) {
    $result = Invoke-Native -FilePath $Path -ArgumentList $NativeArgs -WorkingDirectory $At
    if ($result.ExitCode -ne $ExpectedExit) { throw "Native program failed: $Path (exit $($result.ExitCode)); expected $ExpectedExit." }
    return $result
}
function Invoke-HdGit([string]$At, [string[]]$GitArgs) {
    $gitExe = Resolve-GitExecutable
    $result = Invoke-HdNative $gitExe (@('-c', "safe.directory=$At", '-C', $At) + $GitArgs) $At
    return @($result.StdOut -split "`r?`n" | Where-Object { $_ -ne '' })
}
if (Test-Path -LiteralPath $testRoot) {
    $safe = [IO.Path]::GetFullPath($testRoot)
    if (-not $safe.StartsWith([IO.Path]::GetFullPath((Join-Path $repo '.test-tmp')) + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe test cleanup path.' }
    Remove-Item -LiteralPath $safe -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $testRoot | Out-Null
try {
$runnerTokens = $null; $runnerParseErrors = $null
$runnerAst = [System.Management.Automation.Language.Parser]::ParseFile($runner, [ref]$runnerTokens, [ref]$runnerParseErrors)
$resolverAst = $runnerAst.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Resolve-GitExecutable' }, $true)
Assert ($null -ne $resolverAst) 'Runner does not define Git executable resolution.'
Invoke-Expression $resolverAst.Extent.Text
$nativePatterns = @([regex]::Escape('2>') + '\s*&\s*1', '&\s*\$')
$staticTargets = @(Get-ChildItem -LiteralPath (Join-Path $repo 'ops\windows') -File | Where-Object { $_.Extension -in @('.ps1', '.psm1') } | Select-Object -ExpandProperty FullName) + @(Get-ChildItem -LiteralPath (Join-Path $repo 'tests') -Filter '*.ps1' -File | Select-Object -ExpandProperty FullName)
$reservedParameterNames = @('Args', 'Input', 'This', '_', 'PSItem', 'Error', 'Host', 'Matches')
foreach ($path in $staticTargets) {
    $sourceText = Get-Content -LiteralPath $path -Raw
    foreach ($pattern in $nativePatterns) { Assert (-not [regex]::IsMatch($sourceText, $pattern)) "Forbidden native invocation pattern in $([IO.Path]::GetFileName($path)): $pattern" }
    $tokens = $null; $errors = $null
    $fileAst = [System.Management.Automation.Language.Parser]::ParseFile($path, [ref]$tokens, [ref]$errors)
    foreach ($parameter in $fileAst.FindAll({ param($node) $node -is [System.Management.Automation.Language.ParameterAst] }, $true)) {
        $parameterName = $parameter.Name.VariablePath.UserPath
        Assert ($reservedParameterNames -notcontains $parameterName) "Forbidden PowerShell parameter name '$parameterName' in $([IO.Path]::GetFileName($path))."
    }
}
$simulatedCommands = @(
    [pscustomobject]@{Source='C:\Users\rayda\AppData\Local\hermes\git\bin\git.exe'},
    [pscustomobject]@{Source='C:\Users\rayda\AppData\Local\hermes\git\cmd\git.exe'}
)
Assert ((Resolve-GitExecutable $simulatedCommands) -eq 'C:\Users\rayda\AppData\Local\hermes\git\cmd\git.exe') 'Git resolver did not prefer cmd\git.exe when multiple applications were returned.'
$gitExe = Resolve-GitExecutable
$previousGitConfigGlobal = $env:GIT_CONFIG_GLOBAL
$previousGitConfigNoSystem = $env:GIT_CONFIG_NOSYSTEM
$emptyGitConfig = Join-Path $testRoot 'empty-git-config'
Set-Content -LiteralPath $emptyGitConfig -Value '' -Encoding ASCII
$env:GIT_CONFIG_GLOBAL = $emptyGitConfig
$env:GIT_CONFIG_NOSYSTEM = '1'
$archiveEntries = Get-ChildItem -LiteralPath $repo -Force | Where-Object { $_.Name -notin @('.git', '.test-tmp') }
New-Item -ItemType Directory -Force -Path $sourceRepo | Out-Null
foreach ($entry in $archiveEntries) { Copy-Item -LiteralPath $entry.FullName -Destination $sourceRepo -Recurse -Force }
$initResult = Invoke-HdNative $gitExe @('init', $sourceRepo) $repo
Assert ($initResult.StdErr -match '(?i)hint:') 'git init did not exercise stderr hint capture.'
$null = Invoke-HdGit $sourceRepo @('add', '-A')
$null = Invoke-HdGit $sourceRepo @('-c', 'user.name=HypeDesk archive test', '-c', 'user.email=archive-test@example.invalid', 'commit', '-m', 'Initialize clean archive source')
    $fixtureText = @'
param([string]$RepoPath)
$stamp = [DateTime]::UtcNow.ToString('o')
$social = @{schema_version='social-context.v2'; status='READY'; captured_at_utc=$stamp; research_only=$true; trade_authorization=$false; execution_allowed=$false; source_health=@{}; items=@()}
$market = @{schema_version='market-opportunities.v1'; status='READY'; generated_at_utc=$stamp; market_data_captured_at_utc=$stamp; market_data_source='Fixture'; research_only=$true; trade_authorization=$false; execution_allowed=$false; candidates=@(); social_context=@{schema_version='social-context.v2'}}
[IO.File]::WriteAllText((Join-Path $RepoPath 'data\social-context-v2-latest.json'), ($social | ConvertTo-Json -Depth 8 -Compress), (New-Object System.Text.UTF8Encoding($false)))
[IO.File]::WriteAllText((Join-Path $RepoPath 'data\market-opportunities-hourly-latest.json'), ($market | ConvertTo-Json -Depth 8 -Compress), (New-Object System.Text.UTF8Encoding($false)))
'@
    Set-Content -LiteralPath $fixture -Value $fixtureText -Encoding UTF8
    $failureFixtureText = @'
param([string]$RepoPath)
$git = (Get-Command git -CommandType Application | Select-Object -First 1).Source
$nativeModule = Join-Path $RepoPath 'ops\windows\HypeDesk.Native.psm1'
Import-Module -Name $nativeModule -Force
$failure = Invoke-Native -FilePath $git -ArgumentList @('not-a-real-git-command') -WorkingDirectory $RepoPath
if ($failure.ExitCode -eq 0 -or -not $failure.StdErr) { exit 90 }
exit $failure.ExitCode
'@
    Set-Content -LiteralPath $failureFixture -Value $failureFixtureText -Encoding UTF8
    $advanceText = @'
param([string]$RemoteClonePath)
$ErrorActionPreference = 'Stop'
$old = '2020-01-01T00:00:00Z'
$social = @{schema_version='social-context.v2'; status='READY'; captured_at_utc=$old; research_only=$true; trade_authorization=$false; execution_allowed=$false; source_health=@{}; items=@()}
$market = @{schema_version='market-opportunities.v1'; status='READY'; generated_at_utc=$old; market_data_captured_at_utc=$old; market_data_source='Race fixture'; research_only=$true; trade_authorization=$false; execution_allowed=$false; candidates=@(); social_context=@{schema_version='social-context.v2'}}
[IO.File]::WriteAllText((Join-Path $RemoteClonePath 'data\social-context-v2-latest.json'), ($social | ConvertTo-Json -Depth 8 -Compress), (New-Object System.Text.UTF8Encoding($false)))
[IO.File]::WriteAllText((Join-Path $RemoteClonePath 'data\market-opportunities-hourly-latest.json'), ($market | ConvertTo-Json -Depth 8 -Compress), (New-Object System.Text.UTF8Encoding($false)))
$module = Join-Path $RemoteClonePath 'ops\windows\HypeDesk.Native.psm1'
Import-Module -Name $module -Force
$git = (Get-Command git -CommandType Application | Select-Object -First 1).Source
$result = Invoke-Native -FilePath $git -ArgumentList @('-C', $RemoteClonePath, 'add', '--', 'data/market-opportunities-hourly-latest.json', 'data/social-context-v2-latest.json') -WorkingDirectory $RemoteClonePath
if ($result.ExitCode -ne 0) { exit $result.ExitCode }
$result = Invoke-Native -FilePath $git -ArgumentList @('-C', $RemoteClonePath, '-c', 'user.name=Race fixture', '-c', 'user.email=race-fixture@example.invalid', 'commit', '-m', 'Simulate manual dispatch race') -WorkingDirectory $RemoteClonePath
if ($result.ExitCode -ne 0) { exit $result.ExitCode }
$result = Invoke-Native -FilePath $git -ArgumentList @('-C', $RemoteClonePath, 'push', 'origin', 'main') -WorkingDirectory $RemoteClonePath
if ($result.ExitCode -ne 0) { exit $result.ExitCode }
'@
    Set-Content -LiteralPath $advanceFixture -Value $advanceText -Encoding UTF8
    $parseErrors = @()
    foreach ($path in @($runner, $installer, $uninstaller, $nativeModule, $PSCommandPath)) {
        $tokens = $null; $errors = $null
        [void][System.Management.Automation.Language.Parser]::ParseFile($path, [ref]$tokens, [ref]$errors)
        $parseErrors += $errors
    }
    Assert ($parseErrors.Count -eq 0) "PowerShell parser errors: $($parseErrors | Out-String)"
    Assert (Test-Path -LiteralPath $python -PathType Leaf) 'Fixed production interpreter is unavailable; dry-run cannot prove preflight.'

    $null = Invoke-HdNative $gitExe @('init', '--bare', $bare) $repo
    $null = Invoke-HdNative $gitExe @('-c', "safe.directory=$sourceRepo", 'clone', '--local', $sourceRepo, $clone) $repo
    Invoke-HdGit $clone @('remote', 'set-url', 'origin', $bare) | Out-Null
    Invoke-HdGit $clone @('checkout', '-B', 'main') | Out-Null
    Invoke-HdGit $clone @('config', 'user.name', 'HypeDesk test') | Out-Null
    Invoke-HdGit $clone @('config', 'user.email', 'hypedesk-test@example.invalid') | Out-Null
    New-Item -ItemType Directory -Force -Path (Join-Path $clone 'ops\windows') | Out-Null
    foreach ($scriptName in @('install-hypedesk.ps1', 'uninstall-hypedesk.ps1', 'run-hypedesk.ps1', 'HypeDesk.Native.psm1')) {
        Copy-Item -LiteralPath (Join-Path $repo "ops\windows\$scriptName") -Destination (Join-Path $clone "ops\windows\$scriptName") -Force
    }
    $initialPush = Invoke-HdNative $gitExe @('-C', $clone, 'push', '--progress', '-u', 'origin', 'main') $clone
    Assert ($initialPush.StdErr -match '(?i)(writing objects|to )') 'git push did not exercise stderr progress capture.'
    $initialFetch = Invoke-HdNative $gitExe @('-C', $clone, 'fetch', 'origin', 'main') $clone
    Assert ($initialFetch.StdErr -match '(?i)from ') 'git fetch did not exercise stderr output capture.'
    Invoke-HdGit $clone @('add', 'ops/windows/install-hypedesk.ps1', 'ops/windows/uninstall-hypedesk.ps1', 'ops/windows/run-hypedesk.ps1') | Out-Null
    Invoke-HdGit $clone @('commit', '--allow-empty', '-m', 'Seed disposable publisher test') | Out-Null
    Invoke-HdGit $clone @('push', 'origin', 'main') | Out-Null
    $null = Invoke-HdNative $gitExe @("--git-dir=$bare", 'symbolic-ref', 'HEAD', 'refs/heads/main') $repo
    $null = Invoke-HdNative $gitExe @('clone', $bare, $raceClone) $repo
    Invoke-HdGit $raceClone @('config', 'user.name', 'Race fixture') | Out-Null
    Invoke-HdGit $raceClone @('config', 'user.email', 'race-fixture@example.invalid') | Out-Null
    $remoteBefore = (Invoke-HdNative $gitExe @("--git-dir=$bare", 'rev-parse', 'refs/heads/main') $repo).StdOut.Trim()

    $state = Join-Path $installRoot 'state'
    New-Item -ItemType Directory -Force -Path $state | Out-Null
    $inventoryPath = Join-Path $state 'mock-task-inventory.json'
    [IO.File]::WriteAllText($inventoryPath, (ConvertTo-Json -InputObject @(@{TaskName='Unrelated-Test-Task'; Marker='keep-me'})), (New-Object System.Text.UTF8Encoding($false)))
    Invoke-HdGit $clone @('remote', 'set-url', 'origin', 'https://github.com/attacker/not-market-attention.git') | Out-Null
    $powershellExe = Join-Path $PSHOME 'powershell.exe'
    $wrongOriginInstall = Invoke-HdNative $powershellExe @('-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $installer, '-InstallRoot', $installRoot, '-TestMode') $repo 1
    Assert ($wrongOriginInstall.ExitCode -eq 1) 'Installer accepted an origin outside the disposable test root.'
    Invoke-HdGit $clone @('remote', 'set-url', 'origin', $bare) | Out-Null
    $installOutput = Invoke-HdNative $powershellExe @('-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $installer, '-InstallRoot', $installRoot, '-TestMode') $repo
    $inventory = @(foreach ($hdItem in (Get-Content -LiteralPath $inventoryPath -Raw | ConvertFrom-Json)) { $hdItem })
    Assert (@($inventory | Where-Object TaskName -eq 'Unrelated-Test-Task').Count -eq 1) 'Installer did not preserve the unrelated mocked task.'
    Assert (@($inventory | Where-Object TaskName -eq 'MarketAttention-HypeDesk-Hourly').Count -eq 1) 'Installer did not register exactly its mocked task.'

    Invoke-HdGit $clone @('remote', 'set-url', '--push', 'origin', 'https://github.com/attacker/not-market-attention.git') | Out-Null
    $wrongPushUrlInstall = Invoke-HdNative $powershellExe @('-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $installer, '-InstallRoot', $installRoot, '-TestMode') $repo 1
    Assert ($wrongPushUrlInstall.ExitCode -eq 1) 'Installer accepted a push URL that differs from the approved fetch URL.'
    Invoke-HdGit $clone @('remote', 'set-url', '--push', 'origin', $bare) | Out-Null

    Invoke-HdGit $clone @('remote', 'set-url', 'origin', 'https://github.com/attacker/not-market-attention.git') | Out-Null
    $wrongOriginRun = Invoke-HdNative $powershellExe @('-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $runner, '-InstallRoot', $installRoot, '-TestMode', '-DryRun', '-PythonPath', $python, '-TestRefreshScript', $fixture) $repo 1
    Assert ($wrongOriginRun.ExitCode -eq 1) 'Runner accepted an origin outside the disposable test root.'
    Invoke-HdGit $clone @('remote', 'set-url', 'origin', $bare) | Out-Null
    Invoke-HdGit $clone @('remote', 'set-url', '--push', 'origin', 'https://github.com/attacker/not-market-attention.git') | Out-Null
    $wrongPushUrlRun = Invoke-HdNative $powershellExe @('-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $runner, '-InstallRoot', $installRoot, '-TestMode', '-DryRun', '-PythonPath', $python, '-TestRefreshScript', $fixture) $repo 1
    Assert ($wrongPushUrlRun.ExitCode -eq 1) 'Runner accepted a push URL that differs from the approved fetch URL.'
    Invoke-HdGit $clone @('remote', 'set-url', '--push', 'origin', $bare) | Out-Null
    $runOutput = Invoke-HdNative $powershellExe @('-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $runner, '-InstallRoot', $installRoot, '-TestMode', '-DryRun', '-PythonPath', $python, '-TestRefreshScript', $fixture) $repo
    Assert (($runOutput.StdOut + $runOutput.StdErr) -match 'remote unchanged;') 'Dry run did not explicitly report the remote unchanged.'
    $remoteAfter = (Invoke-HdNative $gitExe @("--git-dir=$bare", 'rev-parse', 'refs/heads/main') $repo).StdOut.Trim()
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

    $nativeFailureJob = Invoke-HdNative $powershellExe @('-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $runner, '-InstallRoot', $installRoot, '-TestMode', '-DryRun', '-PythonPath', $python, '-TestRefreshScript', $failureFixture) $repo 1
    Assert ($nativeFailureJob.ExitCode -eq 1) 'A non-zero native fixture did not fail the scheduled job closed.'
    Assert (($nativeFailureJob.StdOut + $nativeFailureJob.StdErr) -match 'FAILED Fixture refresh failed with exit 1') 'Failed job did not log the native exit code.'

    $publishOutput = Invoke-HdNative $powershellExe @('-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $runner, '-InstallRoot', $installRoot, '-TestMode', '-PythonPath', $python, '-TestRefreshScript', $fixture, '-TestRemoteAdvanceScript', $advanceFixture, '-TestRemoteClonePath', $raceClone) $repo
    Assert (($publishOutput.StdOut + $publishOutput.StdErr) -match 'PUSH_REJECTED') 'Test did not observe the simulated non-fast-forward recovery.'
    Assert (($publishOutput.StdOut + $publishOutput.StdErr) -match 'PUBLISHED remote ref verified') 'Recovered publication did not verify the remote ref.'
    $publishedRemote = (Invoke-HdNative $gitExe @("--git-dir=$bare", 'rev-parse', 'refs/heads/main') $repo).StdOut.Trim()
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
    $lockOutput = Invoke-HdNative $powershellExe @('-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $runner, '-InstallRoot', $installRoot, '-TestMode', '-DryRun', '-PythonPath', $python, '-TestRefreshScript', $fixture) $repo
    $lockHandle.Dispose()
    Assert (($lockOutput.StdOut + $lockOutput.StdErr) -match 'SKIPPED_LOCKED') 'Overlap was not reported as skipped.'
    Remove-Item -LiteralPath $lock -Force

    $uninstallOutput = Invoke-HdNative $powershellExe @('-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $uninstaller, '-InstallRoot', $installRoot, '-TestMode') $repo
    $inventory = @(foreach ($hdItem in (Get-Content -LiteralPath $inventoryPath -Raw | ConvertFrom-Json)) { $hdItem })
    Assert (@($inventory | Where-Object TaskName -eq 'Unrelated-Test-Task').Count -eq 1) 'Uninstaller removed/changed the unrelated mocked task.'
    Assert (@($inventory | Where-Object TaskName -eq 'MarketAttention-HypeDesk-Hourly').Count -eq 0) 'Uninstaller left its mocked task behind.'

    [pscustomobject]@{ result='PASS'; powershell=$PSVersionTable.PSVersion.ToString(); dry_run_remote_before=$remoteBefore; dry_run_remote_after=$remoteAfter; local_dry_run_commit=$localHead; dry_run_commit_paths=$paths; recovered_remote_ref=$publishedRemote; recovered_commit_paths=$publishedPaths; task_inventory='mocked; unrelated task preserved'; lock='overlap skipped'; dry_run='DRY_RUN_REMOTE_UNCHANGED'; nff='capture-time reapply and verified push' } | ConvertTo-Json -Depth 5
} finally {
    if ($null -eq $previousGitConfigGlobal) { Remove-Item Env:\GIT_CONFIG_GLOBAL -ErrorAction SilentlyContinue } else { $env:GIT_CONFIG_GLOBAL = $previousGitConfigGlobal }
    if ($null -eq $previousGitConfigNoSystem) { Remove-Item Env:\GIT_CONFIG_NOSYSTEM -ErrorAction SilentlyContinue } else { $env:GIT_CONFIG_NOSYSTEM = $previousGitConfigNoSystem }
    if (Test-Path -LiteralPath $testRoot) {
        $safe = [IO.Path]::GetFullPath($testRoot)
        if ($safe.StartsWith([IO.Path]::GetFullPath((Join-Path $repo '.test-tmp')) + '\', [StringComparison]::OrdinalIgnoreCase)) { Remove-Item -LiteralPath $safe -Recurse -Force }
    }
}
