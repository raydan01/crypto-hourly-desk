[CmdletBinding()]
param(
    [string]$InstallRoot = 'C:\HypeDesk',
    [switch]$TestMode
)
$ErrorActionPreference = 'Stop'
$TaskName = 'MarketAttention-HypeDesk-Hourly'
$resolvedRoot = [IO.Path]::GetFullPath($InstallRoot).TrimEnd('\')
$scriptRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..')).TrimEnd('\')
$testMarker = '\.test-tmp'
$testMarkerIndex = $scriptRoot.IndexOf($testMarker, [StringComparison]::OrdinalIgnoreCase)
if ($testMarkerIndex -ge 0) { $testRoot = $scriptRoot.Substring(0, $testMarkerIndex + $testMarker.Length) }
else { $testRoot = Join-Path $scriptRoot '.test-tmp' }
$testRoot = [IO.Path]::GetFullPath($testRoot).TrimEnd('\')
if ($TestMode) {
    if (($resolvedRoot -ne $testRoot) -and -not $resolvedRoot.StartsWith($testRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'TestMode root must be under repo/.test-tmp.' }
    $inventoryPath = Join-Path $resolvedRoot 'state\mock-task-inventory.json'
    if (Test-Path -LiteralPath $inventoryPath) {
        $inventory = @(Get-Content -LiteralPath $inventoryPath -Raw | ConvertFrom-Json)
        $remaining = @($inventory | Where-Object { $_.TaskName -ne $TaskName })
        $remaining | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $inventoryPath -Encoding UTF8
    }
    'Task removal: MOCKED; unrelated tasks preserved.'
} else {
    if ($resolvedRoot -ne 'C:\HypeDesk') { throw 'Production install root is fixed at C:\HypeDesk.' }
    Import-Module ScheduledTasks -ErrorAction Stop
    $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($existing) { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false }
    $remaining = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($remaining) { throw 'Task still exists after unregister.' }
    'Task removal: verified; unrelated tasks preserved.'
}
