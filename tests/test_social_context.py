from datetime import datetime, timezone

import social_context


def test_non_comparable_prior_clears_every_prior_based_delta(monkeypatch):
    now = datetime(2026, 10, 13, 7, tzinfo=timezone.utc)
    monkeypatch.setattr(social_context, "_json", lambda url, source: {"coins": [{"item": {"id": "coin", "name": "Coin", "symbol": "COIN", "data": {"total_volume": 121, "market_cap": 500}}}]})
    monkeypatch.setattr(social_context, "_identity", lambda coin_id, cached, captured: {"status": "UNKNOWN", "contracts": [], "warning": "Contract unavailable."})
    monkeypatch.setattr(social_context, "_mentions", lambda source, name, symbol, captured: {"status": "FRESH", "relevant_count_24h": 8, "relevant_count_7d": 9, "headlines": []})
    prior = {
        "captured_at_utc": "2026-10-13T08:00:00Z",
        "items": [{"coingecko_id": "coin", "trending": {"rank": 3}, "market": {"volume_24h_usd": 100}, "mentions": {
            "google_news": {"status": "FRESH", "relevant_count_24h": 2, "relevant_count_7d": 3},
            "reddit": {"status": "FRESH", "relevant_count_24h": 4, "relevant_count_7d": 5},
        }}],
    }

    result = social_context.build_social_context(previous=prior, now=now)
    item = result["items"][0]
    assert item["trending"]["state"] == "INSUFFICIENT_HISTORY"
    assert item["trending"]["previous_rank"] is None
    assert item["trending"]["change"] is None
    assert item["momentum"]["comparison_at_utc"] is None
    assert item["momentum"]["rank_change"] is None
    assert item["momentum"]["volume_change_pct"] is None
    assert all(value is None for source in item["momentum"]["mention_change_by_source"].values() for value in source.values())
