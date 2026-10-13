# HypeDesk Windows publisher

The local Windows task is the only automatic hourly publisher. GitHub's scheduled trigger has been removed; the Actions workflow remains available through `workflow_dispatch` as a manual fallback.

## Installation contract

`install-hypedesk.ps1` and `uninstall-hypedesk.ps1` run in Windows PowerShell 5.1. The intended production root is `C:\HypeDesk`, with the clone at `C:\HypeDesk\repo`, logs under `C:\HypeDesk\logs`, and lock/status files under `C:\HypeDesk\state`. The installer registers one task named `MarketAttention-HypeDesk-Hourly`, as the current user with an interactive token, hourly, only while that user is logged on, with network available and `IgnoreNew` overlap handling. It does not install software or handle credentials. Task registration is gated: the script requires `-ConfirmPersistentInstall`, which Claude must only pass after Ray's explicit confirmation.

The Python runtime is fixed at `C:\CryptoScope\tools\python-3.14\python.exe`. Every run accepts CPython 3.12 or newer, logs the runtime version and imports `json`, `urllib.request`, `xml.etree.ElementTree`, and `ssl` before Git synchronization or collector work. It fails closed on a missing or unsuitable interpreter. The publisher's Git clone is checked against the configured root before the allowed `fetch` and `reset --hard origin/main` operations. Fetch and push output stays out of the logs to avoid exposing credential-bearing remote configuration.

A publisher run takes an exclusive file lock, disables Git credential prompts, validates both artifact schemas and research-only flags, and stages or commits only these exact files. It orders recovery by `market_data_captured_at_utc` for `market-opportunities.v1` and `captured_at_utc` for `social-context.v2`:

- `data/market-opportunities-hourly-latest.json`
- `data/social-context-v2-latest.json`

If a push is rejected as non-fast-forward, it fetches and resets to `origin/main`, compares each remote artifact's capture time with the local capture, and reapplies only newer local artifacts. It retries at most three pushes. It never force-pushes or rebases data files. Logs rotate at 2 MiB (five retained files), and `state/last-run.json` records the final state without credentials. Use `-DryRun` for a full refresh/validation/local commit while explicitly leaving the remote ref unchanged.

The uninstall script removes only this task; it preserves the clone, logs and state.

## If the PC is off

Open the repository's **Actions** tab, select **Refresh hourly market snapshot**, choose **Run workflow** on `main`, then confirm **Run workflow**. This is a manual fallback and does not restore an automatic GitHub schedule. The workflow serializes dispatches and validates the exact two-file allowlist before pushing.

## Safe local checks

The disposable PowerShell job test creates its clone and bare Git remote beneath `repo/.test-tmp/`, injects a fixture refresh script, and uses a mocked scheduler seam. It must not point at `C:\HypeDesk` or inspect/mutate the actual Task Scheduler inventory.
