# social-context.v2 contract

The collector publishes `data/social-context-v2-latest.json` with `schema_version: "social-context.v2"`. This is public research context: `research_only` is true and both `trade_authorization` and `execution_allowed` are false. A machine-readable JSON Schema is in `social-context-v2.schema.json`.

Each queried source entry under `items[].mentions.google_news` and `items[].mentions.reddit` reports two independent news tiers and a separate listing-page count:

- **About this coin**: `coin_count_24h`, `coin_count_7d`, `newest_published_at_utc`, `newest_age_seconds`, and up to three `headlines`. Titles must match the project name or symbol and include a coin-specific marker: `$SYMBOL`, `(SYMBOL)`, an ALL-CAPS whole-word symbol, the name followed within three words by token/coin/memecoin/meme coin/price/presale, or a USD price figure and "price" in the same title. A source suffix alone never makes a headline about the coin.
- **Related crypto buzz**: `related_count_24h`, `related_count_7d`, and up to three `related_headlines`. These titles use the project name in crypto context but do not meet the coin-specific tier. Items without crypto context count in neither tier.
- **Listing pages**: `listing_count_7d` counts dated price-tracker or exchange listing pages separately, with no headlines. The source suffix after the last ` - ` must be CoinGecko, CoinMarketCap, CryptoRank, CoinCodex, CoinStats, CoinLore, Binance, Crypto.com, Coinbase, Kraken, MEXC, Bitget, KuCoin, Gate.io, or LBank, and the title must contain Price Today, Live Price, Price Chart, Converter, Exchange Rate, Markets, Buy & Sell, Analytics, Market Cap, or `/USD`. Listing pages count in neither news tier.

When a project's full name is also its exact ticker, CryptoRank titles remain ambiguous unless `$SYMBOL` or `(SYMBOL)` appears explicitly; those ambiguous results are excluded from the listing count, preserving the zero-match result for CLAUDIA.

Unavailable and not-queried entries use `null` counts. Fresh entries use integer counts, including zero. Counts deduplicate by link and only dated links from the preceding seven days are counted. Main Hype counts, newest age, and headlines use only the coin-specific tier. `momentum.mention_change_by_source` compares only `coin_count_*`; related buzz and listing pages never contribute to momentum.

The UI renders related buzz as secondary context with the wording "Related crypto buzz (headlines using '<name>', not necessarily this coin): N in 7d".

## FOMO watch observations

`items[].fomo_watch.observations` contains descriptive observations and never changes a score, recommendation, or trade gate. `status` is `WATCH_ONLY`, `NO_OBSERVATION`, or `UNKNOWN`; the disclaimer is retained for each item.

Pair-based observations are evaluated against the primary pair only, defined as the pair with the highest known liquidity. This applies to `PAIR_UNDER_24H`, `LIQUIDITY_UNDER_5_PERCENT`, bullish `BUY_SELL_IMBALANCE`, and `DEX_PRICE_MOVE`. The coin-level `VOLUME_ABOVE_MARKET_CAP` observation uses CoinGecko volume and market cap. Secondary pairs remain in `dex_pairs` and do not create FOMO flags.

Each pair-based observation carries `pair_address` and `dex_id` from its originating `dex_pairs[]` entry, plus a `source` string naming CoinGecko or the DEX Screener venue. `pair_address` or `dex_id` may be `null` when the provider omitted that value. Coin-level observations omit pair identity.

`BUY_SELL_IMBALANCE` is bullish only when the primary pair has at least 20 buys and buys are at least 1.5 times sells over 24 hours. `SELLING_PRESSURE` is a separate, neutral note when a pair has at least 20 sells and sells are at least 1.5 times buys. It may describe a secondary pair, carries that pair's identity, and is not counted as a FOMO flag. Counts are displayed as larger side : smaller side, with the dominant side named. Ratios between 1:1 and 1.5:1 produce no imbalance line.

Every rendered observation names its source. Pair observations identify the exact DEX pair with its venue and pair address; CoinGecko observations are labeled CoinGecko.
