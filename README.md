# Crypto Hourly Desk

Upload the contents of this folder to a private HTTPS static host, then open the URL in Safari on iPhone and choose **Share → Add to Home Screen**.

The package contains no portfolio, wallet, liability, credential, or order data. Each hourly artifact now includes a `social_context` block built from CoinGecko trending, Google News RSS, and Reddit RSS where available. Each coin also receives a 0–100 combined opportunity score: market/tradability inputs are weighted 70% and social/news context 30%. Social direction can change a neutral market into bullish or bearish research, while source health and capture time remain visible. The score is a confidence ranking, not a calibrated probability or trade authorization. Replace `data/market-opportunities-hourly-latest.json` with the latest hourly artifact when publishing a new snapshot. The full local command center and its scheduled refresh jobs remain in `dashboard/` and `jobs/`.

All LONG/SHORT labels are research-only. Short-side research remains blocked for execution unless margin permission is independently verified.
