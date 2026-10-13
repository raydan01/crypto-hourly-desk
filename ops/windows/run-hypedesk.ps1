[CmdletBinding()]
param(
    [string]$InstallRoot = 'C:\HypeDesk',
    [switch]$DryRun,
    [switch]$TestMode,
    [string]$PythonPath = 'C:\CryptoScope\tools\python-3.14\python.exe',
    [string]$TestRefreshScript,
    [string]$TestRemoteAdvanceScript,
    [string]$TestRemoteClonePath
)
$ErrorActionPreference = 'Stop'
$AllowedPaths = @('data/market-opportunities-hourly-latest.json', 'data/social-context-v2-latest.json')
$TaskName = 'MarketAttention-HypeDesk-Hourly'
$ScriptRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))

function Write-JobLog([string]$Message) {
    $stamp = [DateTime]::UtcNow.ToString('o')
    $line = "$stamp $Message"
    Write-Output $line
    if ($script:LogPath -and (Test-Path -LiteralPath $script:LogPath)) {
        $file = Get-Item -LiteralPath $script:LogPath
        if ($file.Length -ge 2MB) {
            for ($n = 4; $n -ge 1; $n--) {
                $from = "$($script:LogPath).$n"
                $to = "$($script:LogPath).$($n + 1)"
                if (Test-Path -LiteralPath $from) { Move-Item -LiteralPath $from -Destination $to -Force }
            }
            Move-Item -LiteralPath $script:LogPath -Destination "$($script:LogPath).1" -Force
        }
    }
    if ($script:LogPath) { Add-Content -LiteralPath $script:LogPath -Value $line -Encoding UTF8 }
}
function Invoke-Git([string[]]$GitArgs) {
    $result = & git -C $script:RepoPath @GitArgs 2>&1
    $code = $LASTEXITCODE
    if ($code -ne 0) { throw "git $($GitArgs -join ' ') failed (exit $code); command output suppressed to protect credential-bearing remote configuration." }
    return @($result | ForEach-Object { [string]$_ })
}
function Get-CaptureTime([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "Required artifact missing: $([IO.Path]::GetFileName($Path))" }
    $captureCode = "import json,sys; d=json.load(open(sys.argv[1],encoding='utf-8')); print(d.get('captured_at_utc') or d.get('market_data_captured_at_utc') or d.get('generated_at_utc') or '')"
    $field = & $script:PythonPath -c $captureCode $Path 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $field) { throw "Artifact has no valid capture field: $([IO.Path]::GetFileName($Path))" }
    $parsed = [DateTimeOffset]::MinValue
    if (-not [DateTimeOffset]::TryParse(([string]$field).Trim(), [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AssumeUniversal, [ref]$parsed)) {
        throw "Invalid artifact capture time: $([IO.Path]::GetFileName($Path))"
    }
    return $parsed.ToUniversalTime()
}
function Assert-ArtifactSchemas {
    $marketPath = Join-Path $script:RepoPath $AllowedPaths[0]
    $socialPath = Join-Path $script:RepoPath $AllowedPaths[1]
    $code = @'
import datetime, json, sys
def require(ok, message):
    if not ok: raise ValueError(message)
def stamp(value):
    require(isinstance(value, str) and value, 'missing capture timestamp')
    datetime.datetime.fromisoformat(value.replace('Z', '+00:00'))
def flags(value):
    require(value.get('research_only') is True and value.get('trade_authorization') is False and value.get('execution_allowed') is False, 'research-only safety flags invalid')
market = json.load(open(sys.argv[1], encoding='utf-8'))
social = json.load(open(sys.argv[2], encoding='utf-8'))
require(market.get('schema_version') == 'market-opportunities.v1', 'unsupported market artifact schema')
require(market.get('status') in ('READY', 'DEGRADED'), 'invalid market artifact status')
flags(market)
stamp(market.get('generated_at_utc'))
stamp(market.get('market_data_captured_at_utc'))
require(isinstance(market.get('market_data_source'), str) and market['market_data_source'], 'missing market source')
require(isinstance(market.get('candidates'), list) and all(isinstance(x, dict) for x in market['candidates']), 'invalid market candidates')
nested = market.get('social_context')
require(isinstance(nested, dict) and nested.get('schema_version') == 'social-context.v2', 'invalid embedded social context')
require(social.get('schema_version') == 'social-context.v2', 'unsupported social artifact schema')
require(social.get('status') in ('READY', 'DEGRADED'), 'invalid social artifact status')
flags(social)
stamp(social.get('captured_at_utc'))
require(isinstance(social.get('items'), list) and isinstance(social.get('source_health'), dict), 'invalid social item/health containers')
required = {'coin_count_24h','coin_count_7d','related_count_24h','related_count_7d','listing_count_7d','headlines','related_headlines'}
for item in social['items']:
    mentions = item.get('mentions') if isinstance(item, dict) else None
    require(isinstance(mentions, dict), 'invalid social item mentions')
    for source in ('google_news','reddit'):
        mention = mentions.get(source)
        require(isinstance(mention, dict) and required.issubset(mention), 'invalid social mention fields')
        require(all(isinstance(mention[k], list) and len(mention[k]) <= 3 for k in ('headlines','related_headlines')), 'invalid social headline lists')
        for key in ('coin_count_24h','coin_count_7d','related_count_24h','related_count_7d','listing_count_7d'):
            count = mention[key]
            if mention.get('status') == 'FRESH': require(isinstance(count, int) and not isinstance(count, bool) and count >= 0, 'invalid fresh mention count')
            else: require(count is None, 'non-fresh mention counts must be null')
'@
    $null = & $script:PythonPath -c $code $marketPath $socialPath 2>$null
    if ($LASTEXITCODE -ne 0) { throw 'Artifact schema validation failed; collector output was rejected.' }
}
function Assert-AllowedChanges {
    $changes = Invoke-Git @('status', '--porcelain', '--untracked-files=all')
    foreach ($line in $changes) {
        if ($line.Length -lt 4) { throw 'Could not parse Git status output' }
        $path = $line.Substring(3).Replace('\', '/')
        if ($path -match ' -> ') { $path = ($path -split ' -> ')[-1] }
        if ($AllowedPaths -notcontains $path) { throw "Unexpected changed path; refusing publication: $path" }
    }
    $staged = Invoke-Git @('diff', '--cached', '--name-only')
    foreach ($path in $staged) {
        if ($AllowedPaths -notcontains $path.Replace('\', '/')) { throw "Unexpected staged path; refusing publication: $path" }
    }
}
function Save-Status([string]$State, [string]$Detail, [string]$RemoteRef = '') {
    $obj = [ordered]@{ updated_at_utc = [DateTime]::UtcNow.ToString('o'); state = $State; detail = $Detail; remote_ref = $RemoteRef; local_commit = $script:LocalCommit; dry_run = [bool]$DryRun }
    $tmp = "$script:StatusPath.tmp"
    $obj | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $tmp -Encoding UTF8
    Move-Item -LiteralPath $tmp -Destination $script:StatusPath -Force
}
function Get-Head([string]$Ref) { return ((Invoke-Git @('rev-parse', $Ref)) -join '').Trim() }

$resolvedRoot = [IO.Path]::GetFullPath($InstallRoot).TrimEnd('\')
$testMarker = '\.test-tmp'
$testMarkerIndex = $ScriptRoot.IndexOf($testMarker, [StringComparison]::OrdinalIgnoreCase)
if ($testMarkerIndex -ge 0) { $expectedTestRoot = $ScriptRoot.Substring(0, $testMarkerIndex + $testMarker.Length) }
else { $expectedTestRoot = Join-Path $ScriptRoot '.test-tmp' }
$expectedTestRoot = [IO.Path]::GetFullPath($expectedTestRoot).TrimEnd('\')
if ($TestMode) {
    if (($resolvedRoot -ne $expectedTestRoot) -and -not $resolvedRoot.StartsWith($expectedTestRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'TestMode root must be a disposable path under repo/.test-tmp.' }
    if (-not $TestRefreshScript) { throw 'TestMode requires -TestRefreshScript.' }
    $TestRefreshScript = [IO.Path]::GetFullPath($TestRefreshScript)
    if (-not $TestRefreshScript.StartsWith($expectedTestRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Test refresh script must be beneath repo/.test-tmp.' }
    if ($TestRemoteAdvanceScript) {
        $TestRemoteAdvanceScript = [IO.Path]::GetFullPath($TestRemoteAdvanceScript)
        if (-not $TestRemoteAdvanceScript.StartsWith($expectedTestRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Test remote-advance script must be beneath repo/.test-tmp.' }
        if (-not $TestRemoteClonePath -or -not ([IO.Path]::GetFullPath($TestRemoteClonePath)).StartsWith($expectedTestRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Test remote clone must be beneath repo/.test-tmp.' }
    }
} elseif ($resolvedRoot -ne 'C:\HypeDesk') {
    throw 'Production install root is fixed at C:\HypeDesk.'
}
$script:RepoPath = Join-Path $resolvedRoot 'repo'
if (-not (Test-Path -LiteralPath $script:RepoPath -PathType Container)) { throw "Dedicated clone is missing: $script:RepoPath" }
$gitRoot = (& git -C $script:RepoPath rev-parse --show-toplevel 2>$null)
if ($LASTEXITCODE -ne 0 -or [IO.Path]::GetFullPath([string]$gitRoot).TrimEnd('\') -ne [IO.Path]::GetFullPath($script:RepoPath).TrimEnd('\')) { throw 'Refusing to run: the configured repo path is not the Git worktree root.' }
if ($TestMode -and -not $script:RepoPath.StartsWith($expectedTestRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Test clone escaped repo/.test-tmp.' }
if (-not $TestMode -and $PythonPath -ne 'C:\CryptoScope\tools\python-3.14\python.exe') { throw 'Production interpreter path is fixed at C:\CryptoScope\tools\python-3.14\python.exe.' }
$script:LogDir = Join-Path $resolvedRoot 'logs'
$script:StateDir = Join-Path $resolvedRoot 'state'
New-Item -ItemType Directory -Force -Path $script:LogDir, $script:StateDir | Out-Null
$script:LogPath = Join-Path $script:LogDir 'publisher.log'
$script:StatusPath = Join-Path $script:StateDir 'last-run.json'
$lockPath = Join-Path $script:StateDir 'publisher.lock'
$lockStream = $null
try {
    try { $lockStream = [IO.File]::Open($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None) }
    catch [IO.IOException] { Write-JobLog 'SKIPPED_LOCKED another publisher run holds the exclusive lock'; Save-Status 'SKIPPED_LOCKED' 'Another run holds the local lock.'; return }
    Write-JobLog 'STARTED'
    if (-not (Test-Path -LiteralPath $PythonPath -PathType Leaf)) { throw "PREFLIGHT_FAILED fixed interpreter missing: $PythonPath" }
    $probe = & $PythonPath -c "import sys,json,urllib.request,xml.etree.ElementTree,ssl; print('CPython' if sys.implementation.name == 'cpython' else sys.implementation.name, sys.version_info[0], sys.version_info[1])" 2>&1
    if ($LASTEXITCODE -ne 0) { throw "PREFLIGHT_FAILED interpreter smoke import failed: $($probe -join ' ')" }
    $match = [regex]::Match(($probe -join ' '), '^CPython\s+(\d+)\s+(\d+)')
    if (-not $match.Success) { throw "PREFLIGHT_FAILED interpreter is not CPython: $($probe -join ' ')" }
    $pyMajor = [int]$match.Groups[1].Value; $pyMinor = [int]$match.Groups[2].Value
    Write-JobLog "INTERPRETER CPython $pyMajor.$pyMinor; stdlib smoke imports passed"
    if (($pyMajor -lt 3) -or ($pyMajor -eq 3 -and $pyMinor -lt 12)) { throw "PREFLIGHT_FAILED CPython >=3.12 required; found $pyMajor.$pyMinor" }
    $script:PythonPath = $PythonPath

    $env:GIT_TERMINAL_PROMPT = '0'; $env:GCM_INTERACTIVE = 'Never'
    Invoke-Git @('fetch', 'origin', 'main') | Out-Null
    Write-JobLog 'FETCH origin/main succeeded; Git output suppressed'
    Invoke-Git @('reset', '--hard', 'origin/main') | Out-Null
    Write-JobLog 'SYNCED reset --hard origin/main inside verified dedicated clone'
    if ($TestMode) {
        & powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $TestRefreshScript -RepoPath $script:RepoPath
        if ($LASTEXITCODE -ne 0) { throw "Fixture refresh failed with exit $LASTEXITCODE" }
        if ($TestRemoteAdvanceScript) {
            & powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $TestRemoteAdvanceScript -RemoteClonePath $TestRemoteClonePath
            if ($LASTEXITCODE -ne 0) { throw "Disposable remote advance fixture failed with exit $LASTEXITCODE" }
        }
    } else {
        & $PythonPath (Join-Path $script:RepoPath 'refresh_hourly.py')
        if ($LASTEXITCODE -ne 0) { throw "refresh_hourly.py failed with exit $LASTEXITCODE" }
    }
    Assert-ArtifactSchemas
    foreach ($rel in $AllowedPaths) { [void](Get-CaptureTime (Join-Path $script:RepoPath $rel)) }
    Assert-AllowedChanges
    Invoke-Git (@('add', '--') + $AllowedPaths) | Out-Null
    Assert-AllowedChanges
    $staged = Invoke-Git @('diff', '--cached', '--name-only')
    if (@($staged).Count -gt 0) {
        foreach ($p in $staged) { if ($AllowedPaths -notcontains $p.Replace('\', '/')) { throw "Refusing unexpected commit path: $p" } }
        Invoke-Git @('commit', '-m', 'Refresh hourly market snapshot') | ForEach-Object { Write-JobLog "GIT $_" }
    } else { Write-JobLog 'NO_CHANGES' }
    $localHead = Get-Head 'HEAD'
    $script:LocalCommit = $localHead
    if ($DryRun) {
        Write-JobLog "DRY_RUN remote unchanged; local HEAD $localHead; no push attempted"
        Save-Status 'DRY_RUN_REMOTE_UNCHANGED' 'Artifacts validated and local commit prepared; remote ref was not changed.' (Get-Head 'origin/main')
        return
    }
    $published = $false
    for ($attempt = 1; $attempt -le 3; $attempt++) {
        $pushOutput = & git -C $script:RepoPath push origin HEAD:main 2>&1
        $pushCode = $LASTEXITCODE
        if ($pushCode -eq 0) {
            Invoke-Git @('fetch', 'origin', 'main') | Out-Null
            $remoteHead = Get-Head 'origin/main'
            if ($remoteHead -ne $localHead) { throw "Push returned success but remote ref does not equal local commit (remote $remoteHead, local $localHead)." }
            Write-JobLog "PUBLISHED remote ref verified at $remoteHead"
            Save-Status 'PUBLISHED' 'Remote ref verified at the local publisher commit.' $remoteHead
            $published = $true
            break
        }
        $pushText = ($pushOutput -join ' ')
        if ($pushText -notmatch '(?i)non-fast-forward|fetch first|\[rejected\]') { throw "Push failed (exit $pushCode); authentication and remote details were not logged." }
        Write-JobLog "PUSH_REJECTED attempt=$attempt; capture-time recovery"
        if ($attempt -eq 3) { break }
        Invoke-Git @('fetch', 'origin', 'main') | Out-Null
        $capturedLocal = @{}
        $tempDir = Join-Path $script:StateDir 'reapply'
        New-Item -ItemType Directory -Force -Path $tempDir | Out-Null
        foreach ($rel in $AllowedPaths) { Copy-Item -LiteralPath (Join-Path $script:RepoPath $rel) -Destination (Join-Path $tempDir ([IO.Path]::GetFileName($rel))) -Force; $capturedLocal[$rel] = Get-CaptureTime (Join-Path $tempDir ([IO.Path]::GetFileName($rel))) }
        Invoke-Git @('reset', '--hard', 'origin/main') | Out-Null
        $reapplied = @()
        foreach ($rel in $AllowedPaths) {
            $remoteFile = Join-Path $script:RepoPath $rel
            $remoteTime = Get-CaptureTime $remoteFile
            $localCopy = Join-Path $tempDir ([IO.Path]::GetFileName($rel))
            if ($capturedLocal[$rel] -gt $remoteTime) { Copy-Item -LiteralPath $localCopy -Destination $remoteFile -Force; $reapplied += $rel }
        }
        if ($reapplied.Count -eq 0) { throw 'Remote artifacts are at least as new as this capture; stopped without publishing stale data.' }
        Assert-AllowedChanges
        Invoke-Git (@('add', '--') + $reapplied) | Out-Null
        Assert-AllowedChanges
        Invoke-Git @('commit', '-m', 'Refresh hourly market snapshot (capture-time recovery)') | ForEach-Object { Write-JobLog "GIT $_" }
        $localHead = Get-Head 'HEAD'
        $script:LocalCommit = $localHead
    }
    if (-not $published) { throw 'Push retries exhausted after three attempts; remote was not force-updated.' }
} catch {
    $msg = $_.Exception.Message
    Write-JobLog "FAILED $msg"
    try { Save-Status 'FAILED' $msg } catch { }
    exit 1
} finally {
    if ($lockStream) { $lockStream.Dispose() }
    Remove-Item Env:\GIT_TERMINAL_PROMPT -ErrorAction SilentlyContinue
    Remove-Item Env:\GCM_INTERACTIVE -ErrorAction SilentlyContinue
}

