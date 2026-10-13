# social-context.v2 contract

The collector publishes `data/social-context-v2-latest.json` with `schema_version: "social-context.v2"`. This is public research context: `research_only` is true and both `trade_authorization` and `execution_allowed` are false. A machine-readable JSON Schema is in `social-context-v2.schema.json`.

Each queried source entry under `items[].mentions.google_news` and `items[].mentions.reddit` reports two independent news tiers and a separate listing-page count:

- **About this coin**: `coin_count_24h`, `coin_count_7d`, `newest_published_at_utc`, `newest_age_seconds`, and up to three `headlines`. Titles must match the project name or symbol and include a coin-specific marker: `$SYMBOL`, `(SYMBOL)`, an ALL-CAPS whole-word symbol, the name followed within three words by token/coin/memecoin/meme coin/price/presale, or a USD price figure and "price" in the same title. A source suffix alone never makes a headline about the coin.
- **Related crypto buzz**: `related_count_24h`, `related_count_7d`, and up to three `related_headlines`. These titles use the project name in crypto context but do not meet the coin-specific tier. Items without crypto context count in neither tier.
- **Listing pages**: `listing_count_7d` counts dated price-tracker or exchange listing pages separately, with no headlines. The source suffix after the last ` - ` must be CoinGecko, CoinMarketCap, CryptoRank, CoinCodex, CoinStats, CoinLore, Binance, Crypto.com, Coinbase, Kraken, MEXC, Bitget, KuCoin, Gate.io, or LBank, and the title must contain Price Today, Live Price, Price Chart, Converter, Exchange Rate, Markets, Buy & Sell, Analytics, Market Cap, or `/USD`. Listing pages count in neither news tier.

When a project's full name is also its exact ticker, CryptoRank titles remain ambiguous unless `$SYMBOL` or `(SYMBOL)` appears explicitly; those ambiguous results are excluded from the listing count, preserving the zero-match result for CLAUDIA.

Unavailable and not-queried entries use `null` counts. Fresh entries use integer counts, including zero. Counts deduplicate by link and only dated links from the preceding seven days are counted. Main Hype counts, newest age, and headlines use only the coin-specific tier. `momentum.mention_change_by_source` compares only `coin_count_*`; related buzz and listing pages never contribute to momentum.

The UI renders related buzz as secondary context with the wording “Related crypto buzz (headlines using '<name>', not necessarily this coin): N in 7d”.
