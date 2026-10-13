from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import social_context


FIXTURE = Path(__file__).parent / "fixtures" / "google-news-live-recorded.xml"


def test_recorded_google_news_titles_require_asset_and_crypto_context(monkeypatch):
    recorded = FIXTURE.read_bytes()
    requested = []

    def get(url, accept, provider=None):
        requested.append(url)
        return recorded

    monkeypatch.setattr(social_context, "_get", get)
    now = datetime(2026, 10, 13, 8, tzinfo=timezone.utc)
    for name, symbol in (("Pearl", "PRL"), ("Claudia", "CLAUDIA")):
        result = social_context._mentions("google_news", name, symbol, now)
        assert result["relevant_count_7d"] == 0
        assert result["headlines"] == []
    bunker = social_context._mentions("google_news", "Bunker Mode", "BUNKER", now)
    assert bunker["relevant_count_7d"] == 1
    assert bunker["headlines"][0]["title"].startswith("Bunker Mode leads crypto search interest")
    crawlerpad = social_context._mentions("google_news", "Crawlerpad", "CRAWLER", now)
    assert crawlerpad["relevant_count_7d"] == 1
    assert crawlerpad["headlines"][0]["title"].startswith("Crawlerpad Price: CRAWLER/USD")
    assert social_context._match({"title": "Near Protocol (NEAR) jumps…"}, "Near Protocol", "NEAR") == "title"
    assert all("&hl=en-US&gl=US&ceid=US:en" in url for url in requested)
    assert parse_qs(urlsplit(requested[0]).query)["q"][0] == '"Pearl" (crypto OR token OR coin OR "PRL") when:7d'


def test_google_news_body_alone_cannot_match_a_recorded_title():
    recorded_titles = {item["title"] for item in social_context._rss_items(FIXTURE.read_bytes())}
    unrelated_title = next(title for title in recorded_titles if title.startswith("Auburn holds Pro Day"))
    assert social_context._match({"title": unrelated_title, "body": "Pearl crypto token"}, "Pearl", "PRL") is None


def test_coin_identity_lookup_failure_is_not_reported_as_unknown(monkeypatch):
    import urllib.error

    calls = []
    def failed(_url, _provider=None):
        calls.append(1)
        raise urllib.error.HTTPError("https://api.coingecko.com/", 429, "rate limited", {}, None)

    monkeypatch.setattr(social_context, "_json", failed)
    monkeypatch.setattr(social_context.time, "sleep", lambda _seconds: None)
    monkeypatch.setattr(social_context, "_last_response_headers", {"retry-after": "3"})
    social_context._cg_identity_stopped = False
    try:
        with __import__("pytest").raises(urllib.error.HTTPError):
            social_context._identity("pudgy-penguins", {}, datetime(2026, 10, 13, tzinfo=timezone.utc))
        assert social_context._cg_identity_stopped is True
        assert len(calls) == 2
    finally:
        social_context._cg_identity_stopped = False


def test_identity_retry_honours_retry_after(monkeypatch):
    import urllib.error

    calls = []
    waits = []

    def json_response(url, _provider=None):
        calls.append(url)
        if len(calls) == 1:
            raise urllib.error.HTTPError(url, 429, "rate limited", {}, None)
        return {"platforms": {}}

    monkeypatch.setattr(social_context, "_json", json_response)
    monkeypatch.setattr(social_context, "_last_response_headers", {"retry-after": "3"})
    monkeypatch.setattr(social_context.time, "sleep", waits.append)
    social_context._cg_identity_stopped = False
    social_context._cg_identity_deadline = None
    assert social_context._identity_json("https://api.coingecko.com/identity") == {"platforms": {}}
    assert len(calls) == 2
    assert waits == [3.0]


def test_live_identity_failures_and_reddit_limits_are_reported_in_health(monkeypatch):
    import urllib.error

    now = datetime(2026, 10, 13, 8, tzinfo=timezone.utc)

    def json_response(url, _provider=None):
        if "/search/trending" in url:
            return {"coins": [{"item": {"id": "pudgy-penguins", "name": "Pudgy Penguins", "symbol": "PENGU", "data": {}}}]}
        raise urllib.error.HTTPError(url, 429, "rate limited", {}, None)

    monkeypatch.setattr(social_context, "_json", json_response)
    monkeypatch.setattr(social_context.time, "sleep", lambda _seconds: None)
    monkeypatch.setattr(social_context, "_mentions", lambda source, name, symbol, captured: {"status": "UNAVAILABLE", "error_class": "RATE_LIMITED", "reason": "rate-limited by Reddit", "relevant_count_24h": None, "relevant_count_7d": None, "headlines": []} if source == "reddit" else {"status": "FRESH", "relevant_count_24h": 0, "relevant_count_7d": 0, "headlines": []})
    result = social_context.build_social_context(previous={"items": []}, now=now)
    identity = result["items"][0]["identity"]
    assert identity["status"] == "LOOKUP_FAILED"
    assert identity["http_status"] == 429
    assert identity["warning"] == "Contract lookup failed this capture (CoinGecko limit). Retry next hour"
    assert result["source_health"]["coingecko_identity"]["cache_hit_count"] == 0
    assert result["source_health"]["reddit"]["error_class"] == "RATE_LIMITED"
    assert social_context.CG_MIN_INTERVAL == 15.0


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
