Recorded response fixtures
=========================

coingecko-trending.json, coingecko-coin.json, dex-pairs.json, and google-news.xml are trimmed public response bodies recorded on 2026-10-12 and copied from inputs/recorded-live-2026-10-12. Their values and fields are recorded values; no response fields were fabricated.

reddit-search.xml is a parser-shape fixture from the 2026-10-12 earlier successful subreddit probe described by loop/evidence/p2.py. It is an empty Atom parser-shape fixture (not a response body); its only purpose is to preserve the 2026-10-12 earlier successful subreddit probe field shape entry/updated/title/link. The live 2026-10-12 sitewide requests returned 429; those actual headers are preserved separately and replayed by tests. No successful sitewide Reddit body was recorded that day.
