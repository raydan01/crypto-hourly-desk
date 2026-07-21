# Crypto Hourly Desk

Upload the contents of this folder to a private HTTPS static host, then open the URL in Safari on iPhone and choose **Share → Add to Home Screen**.

The package contains no portfolio, wallet, liability, credential, or order data. Each hourly artifact now includes a `social_context` block built from CoinGecko trending, Google News RSS, and Reddit RSS where available. Source health and capture time are shown in the app; social attention is context-only and never changes the market bias or authorizes a trade. Replace `data/market-opportunities-hourly-latest.json` with the latest hourly artifact when publishing a new snapshot. The full local command center and its scheduled refresh jobs remain in `dashboard/` and `jobs/`.

All LONG/SHORT labels are research-only. Short-side research remains blocked for execution unless margin permission is independently verified.
