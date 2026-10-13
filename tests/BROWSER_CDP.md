# Hype browser CDP check

Run from the repository root using the configured Node runtime:

```powershell
& 'C:\Users\rayda\AppData\Local\hermes\node\node.exe' tests/browser_cdp.mjs
```

The script serves the production app paths on a dynamically assigned loopback port, substitutes the Hype artifact route with `tests/fixtures/social-context-v2-ui.json` (replayed from recorded 2026-10-12 provider responses), and drives installed Microsoft Edge headless through CDP at 390×844. It requires no packages or network access and cleans up only the Edge process and HTTP server it starts.
The CDP script blocks external Kraken, CoinGecko, Google News, Reddit, and DEX Screener URLs; only production app assets and the recorded local Hype fixture are served.
