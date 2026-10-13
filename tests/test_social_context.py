from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import social_context


FIXTURES = Path(__file__).parent / "fixtures" / "recorded"
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
        assert result["coin_count_7d"] == 0
        assert result["headlines"] == []
    bunker = social_context._mentions("google_news", "Bunker Mode", "BUNKER", now)
    assert bunker["coin_count_7d"] == 1
    assert bunker["listing_count_7d"] == 1
    assert bunker["headlines"][0]["title"].startswith("Bunker Mode leads crypto search interest")
    crawlerpad = social_context._mentions("google_news", "Crawlerpad", "CRAWLER", now)
    assert crawlerpad["coin_count_7d"] == 0
    assert crawlerpad["listing_count_7d"] == 1
    assert social_context._match({"title": "Near Protocol (NEAR) jumps…"}, "Near Protocol", "NEAR") == "title"
    assert all("&hl=en-US&gl=US&ceid=US:en" in url for url in requested)
    assert parse_qs(urlsplit(requested[0]).query)["q"][0] == '"Pearl" (crypto OR token OR coin OR "PRL") when:7d'


def test_google_news_body_alone_cannot_match_a_recorded_title():
    recorded_titles = {item["title"] for item in social_context._rss_items(FIXTURE.read_bytes())}
    unrelated_title = next(title for title in recorded_titles if title.startswith("Auburn holds Pro Day"))
    assert social_context._match({"title": unrelated_title, "body": "Pearl crypto token"}, "Pearl", "PRL") is None


def test_full_recorded_rss_uses_separate_coin_and_related_buzz_tiers(monkeypatch):
    files = {
        "Pearl": FIXTURES / "google-news-pearl-7d.xml",
        "Claudia": FIXTURES / "google-news-claudia-7d.xml",
        "Bunker Mode": FIXTURES / "google-news-bunker-mode-7d.xml",
        "Crawlerpad": FIXTURES / "google-news-crawlerpad-7d.xml",
    }
    recorded = {name: path.read_bytes() for name, path in files.items()}
    assert all(len(social_context._rss_items(payload)) > 1 for payload in recorded.values())
    now = datetime(2026, 10, 13, 8, tzinfo=timezone.utc)

    def get(url, _accept, provider=None):
        from urllib.parse import parse_qs, urlsplit
        query = parse_qs(urlsplit(url).query)["q"][0]
        name = next(key for key in recorded if key.casefold() in query.casefold())
        return recorded[name]

    monkeypatch.setattr(social_context, "_get", get)
    results = {
        name: social_context._mentions("google_news", name, symbol, now)
        for name, symbol in (("Pearl", "PRL"), ("Claudia", "CLAUDIA"), ("Bunker Mode", "BUNKER"), ("Crawlerpad", "CRAWLER"))
    }
    assert [(results[name]["coin_count_7d"], results[name]["related_count_7d"]) for name in ("Pearl", "Claudia")] == [(0, 0), (0, 0)]
    assert (results["Pearl"]["coin_count_7d"], results["Pearl"]["listing_count_7d"], results["Pearl"]["related_count_7d"]) == (0, 0, 0)
    assert (results["Claudia"]["coin_count_7d"], results["Claudia"]["listing_count_7d"], results["Claudia"]["related_count_7d"]) == (0, 0, 0)
    assert (results["Bunker Mode"]["coin_count_7d"], results["Bunker Mode"]["listing_count_7d"]) == (1, 7)
    assert results["Bunker Mode"]["related_count_7d"] == 45
    assert results["Bunker Mode"]["headlines"][0]["title"].startswith("Bunker Mode leads crypto search interest")
    assert (results["Crawlerpad"]["coin_count_7d"], results["Crawlerpad"]["listing_count_7d"], results["Crawlerpad"]["related_count_7d"]) == (0, 1, 0)
    bunker_titles = [row["title"] for row in social_context._rss_items(recorded["Bunker Mode"])]
    assert social_context._mention_tier({"title": next(title for title in bunker_titles if title.startswith("Keep calm and enter"))}, "Bunker Mode", "BUNKER") == "related"
    assert social_context._mention_tier({"title": next(title for title in bunker_titles if title.startswith("Ethereum Researcher Urges Crypto Bunker Mode"))}, "Bunker Mode", "BUNKER") == "related"


def test_three_recorded_near_headlines_match_coin_tier():
    output = (FIXTURES / "live-collector-output-058b346.json").read_text(encoding="utf-8")
    import json
    captured = json.loads(output)
    near = next(item for item in captured["items"] if item["coingecko_id"] == "near")
    samples = near["mentions"]["google_news"]["headlines"]
    assert len(samples) == 3
    assert all(social_context._mention_tier(row, "NEAR Protocol", "NEAR") == "coin" for row in samples)


def test_test_sources_keep_recorded_paths_inside_repository():
    repo = Path(__file__).resolve().parents[1]
    test_sources = [repo / "test_mobile_pwa.py", *sorted((repo / "tests").glob("test_*.py"))]
    external_root = "ROOT" + ".parent / " + '"' + "inputs" + '"'
    external_parents = "parents[" + "2] / " + '"' + "inputs" + '"'
    for source in test_sources:
        text = source.read_text(encoding="utf-8")
        assert external_root not in text, source
        assert external_parents not in text, source
    for fixture in FIXTURES.glob("*"):
        assert fixture.resolve().is_relative_to(repo)


def test_mention_tier_markers_and_non_coin_context():
    tier = social_context._mention_tier
    assert tier({"title": "Bunker Mode leads crypto search interest despite 21.65% price drop to $0.0206"}, "Bunker Mode", "BUNKER") == "coin"
    assert tier({"title": "$BUNKER hits a new high"}, "Bunker Mode", "BUNKER") == "coin"
    assert tier({"title": "Bunker Mode (BUNKER) market report"}, "Bunker Mode", "BUNKER") == "coin"
    assert tier({"title": "New BUNKER token launches today"}, "Bunker Mode", "BUNKER") == "coin"
    assert tier({"title": "New bunker token launches today"}, "Bunker Mode", "BUNKER") is None
    assert tier({"title": "Bunker Mode Price Today - CoinGecko"}, "Bunker Mode", "BUNKER") is None
    assert social_context._is_listing_page({"title": "Bunker Mode Price Today - CoinGecko"})
    assert tier({"title": "Bunker Mode security warning - CoinMarketCap"}, "Bunker Mode", "BUNKER") == "related"
    assert tier({"title": "Keep calm and enter 'bunker mode,' crypto bros say"}, "Bunker Mode", "BUNKER") == "related"
    assert tier({"title": "Bunker Mode security guide for Ethereum users"}, "Bunker Mode", "BUNKER") == "related"
    assert tier({"title": "Bunker Mode is a quiet room feature"}, "Bunker Mode", "BUNKER") is None
    assert tier({"title": "$CLAUDIA quote on CryptoRank"}, "Claudia", "CLAUDIA") == "coin"


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
    monkeypatch.setattr(social_context, "_mentions", lambda source, name, symbol, captured: {"status": "UNAVAILABLE", "error_class": "RATE_LIMITED", "reason": "rate-limited by Reddit", "coin_count_24h": None, "coin_count_7d": None, "related_count_24h": None, "related_count_7d": None, "listing_count_7d": None, "headlines": [], "related_headlines": []} if source == "reddit" else {"status": "FRESH", "coin_count_24h": 0, "coin_count_7d": 0, "related_count_24h": 0, "related_count_7d": 0, "listing_count_7d": 0, "headlines": [], "related_headlines": []})
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
    monkeypatch.setattr(social_context, "_mentions", lambda source, name, symbol, captured: {"status": "FRESH", "coin_count_24h": 8, "coin_count_7d": 9, "related_count_24h": 0, "related_count_7d": 0, "listing_count_7d": 0, "headlines": [], "related_headlines": []})
    prior = {
        "captured_at_utc": "2026-10-13T08:00:00Z",
        "items": [{"coingecko_id": "coin", "trending": {"rank": 3}, "market": {"volume_24h_usd": 100}, "mentions": {
            "google_news": {"status": "FRESH", "coin_count_24h": 2, "coin_count_7d": 3},
            "reddit": {"status": "FRESH", "coin_count_24h": 4, "coin_count_7d": 5},
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
    assert item["mentions"]["google_news"]["coin_count_7d"] == 9


def test_related_buzz_does_not_change_mention_momentum(monkeypatch):
    now = datetime(2026, 10, 13, 8, tzinfo=timezone.utc)
    monkeypatch.setattr(social_context, "_json", lambda url, source: {"coins": [{"item": {"id": "coin", "name": "Coin", "symbol": "COIN", "data": {"total_volume": 100, "market_cap": 500}}}]})
    monkeypatch.setattr(social_context, "_identity", lambda coin_id, cached, captured: {"status": "UNKNOWN", "contracts": [], "warning": "Contract unavailable."})
    monkeypatch.setattr(social_context, "_mentions", lambda source, name, symbol, captured: {"status": "FRESH", "coin_count_24h": 1, "coin_count_7d": 2, "related_count_24h": 90, "related_count_7d": 900, "listing_count_7d": 0, "headlines": [], "related_headlines": []})
    prior = {"captured_at_utc": "2026-10-13T07:00:00Z", "items": [{"coingecko_id": "coin", "trending": {"rank": 1}, "market": {"volume_24h_usd": 100}, "mentions": {
        "google_news": {"status": "FRESH", "coin_count_24h": 1, "coin_count_7d": 2, "related_count_24h": 0, "related_count_7d": 0},
        "reddit": {"status": "FRESH", "coin_count_24h": 1, "coin_count_7d": 2, "related_count_24h": 0, "related_count_7d": 0},
    }}]}
    result = social_context.build_social_context(previous=prior, now=now)
    item = result["items"][0]
    assert item["momentum"]["mention_change_by_source"]["google_news"] == {"24h": 0, "7d": 0}
    assert item["momentum"]["state"] == "FLAT"


def test_v2_validation_requires_all_mention_categories():
    entry = {"status": "FRESH", "coin_count_24h": 0, "coin_count_7d": 0, "related_count_24h": 0, "related_count_7d": 0, "listing_count_7d": 0, "headlines": [], "related_headlines": []}
    value = {"schema_version": "social-context.v2", "research_only": True, "trade_authorization": False, "execution_allowed": False, "source_health": {}, "items": [{"mentions": {"google_news": dict(entry), "reddit": dict(entry)}}]}
    assert social_context.validate_social_context(value)
    del value["items"][0]["mentions"]["google_news"]["listing_count_7d"]
    assert not social_context.validate_social_context(value)
    value["items"][0]["mentions"]["google_news"]["listing_count_7d"] = 0
    del value["items"][0]["mentions"]["google_news"]["related_count_7d"]
    assert not social_context.validate_social_context(value)
