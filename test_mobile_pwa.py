"""Offline contract, collector, scorer, and shell tests."""
from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import pytest

ROOT = Path(__file__).parent
sys.path.insert(0, str(ROOT))
import social_context
from research.market_opportunities import score_candidate

FIXTURES = ROOT / "tests" / "fixtures"
NOW = datetime(2026, 10, 13, 7, 0, tzinfo=timezone.utc)
RECORDED = ROOT.parent / "inputs" / "recorded-live-2026-10-12"


def save_proof(name: str, value) -> None:
    proof_dir = ROOT / ".proof"
    proof_dir.mkdir(exist_ok=True)
    path = proof_dir / name
    if isinstance(value, str):
        path.write_text(value, encoding="utf-8")
    else:
        path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def replay_response(url: str, accept: str = "application/json") -> tuple[int, bytes]:
    if "/search/trending" in url:
        payload = json.loads((FIXTURES / "coingecko-trending.json").read_text(encoding="utf-8"))
        payload["coins"] = [row for row in payload["coins"] if row["item"]["id"] == "crawlerpad"]
        return 200, json.dumps(payload).encode()
    if "/coins/crawlerpad" in url:
        return 200, (FIXTURES / "coingecko-coin.json").read_bytes()
    if "/coins/pudgy-penguins" in url:
        return 200, (FIXTURES / "coingecko-coin-pudgy-penguins.json").read_bytes()
    if "/coins/identity-md-6900" in url:
        return 200, (FIXTURES / "coingecko-coin-identity-md-6900.json").read_bytes()
    if "/coins/bitcoin" in url:
        return 200, (FIXTURES / "coingecko-coin-bitcoin.json").read_bytes()
    if "news.google.com" in url:
        return 200, (FIXTURES / "google-news.xml").read_bytes()
    if "www.reddit.com" in url:
        social_context._last_response_headers = {"x-ratelimit-used": "1", "x-ratelimit-remaining": "0.0", "x-ratelimit-reset": "43"}
        return 429, (FIXTURES / "reddit-429.headers.txt").read_bytes()
    if "api.dexscreener.com" in url:
        return 200, (FIXTURES / "dex-pairs.json").read_bytes()
    raise AssertionError(f"unrecorded HTTP request: {url}")


def test_production_default_collector_replays_real_shape_http_boundary(monkeypatch):
    monkeypatch.setattr(social_context, "_http_get", replay_response)
    monkeypatch.setattr(social_context.time, "sleep", lambda _seconds: None)
    monkeypatch.setattr(social_context.time, "monotonic", lambda: 100.0)
    monkeypatch.setattr(social_context, "_last_cg_call", 0.0)
    monkeypatch.setattr(social_context, "_last_reddit_call", 0.0)
    result = social_context.build_social_context(now=NOW, max_trending=1, enriched=1, previous=None)
    assert social_context.validate_social_context(result)
    assert result["schema_version"] == "social-context.v2"
    assert result["research_only"] and result["trade_authorization"] is False and result["execution_allowed"] is False
    assert result["items"][0]["coingecko_id"] == "crawlerpad"
    item = result["items"][0]
    assert item["mentions"]["google_news"]["relevant_count_24h"] == 1
    assert item["mentions"]["google_news"]["relevant_count_7d"] == 1
    assert item["mentions"]["google_news"]["undated_matched_item_count"] == 0
    assert item["mentions"]["google_news"]["headlines"][0]["matched_text"] in {"title", "body"}
    assert len(item["mentions"]["google_news"]["headlines"]) == 1
    assert item["mentions"]["google_news"]["headlines"][0]["title"].startswith("Crawlerpad Price")
    assert item["mentions"]["google_news"]["headlines"][0]["url"].startswith("https://news.google.com/")
    assert item["identity"]["contracts"][0]["address"] == "CQCDTp8rsFV3PhaPeYjcCW5LdGTxi6jFx7eC3UXnpump"
    assert len(item["dex_pairs"]) == 2
    assert item["dex_pairs"][0]["chain"] == "solana"
    save_proof("collector-production-default.json", {"fixture_origin": "trimmed real public responses recorded 2026-10-12", "collector_output": result})
    save_proof("mention-relevance-report.md", "# Mention relevance replay\n\nReplay used the recorded Crawlerpad Google News RSS response. It retained the one dated, directly matching item in the 24-hour and 7-day windows; unrelated results were excluded.\n")
    save_proof("detail-card-fixtures.md", "# Detail card fixture replay\n\nReplay used the recorded Crawlerpad identity and DEX Screener responses. Both recorded Solana pairs are retained.\n")


def test_reddit_429_is_degraded_without_zero_or_retry_burst(monkeypatch):
    calls = []

    def boundary(url, accept="application/json"):
        calls.append(url)
        if "www.reddit.com" in url:
            monkeypatch.setattr(social_context, "_last_response_headers", {"x-ratelimit-used": "1", "x-ratelimit-remaining": "0.0", "x-ratelimit-reset": "43"})
            return 429, b""
        return replay_response(url, accept)

    monkeypatch.setattr(social_context, "_http_get", boundary)
    monkeypatch.setattr(social_context.time, "sleep", lambda _seconds: None)
    monkeypatch.setattr(social_context.time, "monotonic", lambda: 100.0)
    monkeypatch.setattr(social_context, "_last_cg_call", 0.0)
    monkeypatch.setattr(social_context, "_last_reddit_call", 0.0)
    result = social_context.build_social_context(now=NOW, max_trending=1, enriched=1, previous=None)
    reddit = result["items"][0]["mentions"]["reddit"]
    assert reddit["status"] == "UNAVAILABLE"
    assert reddit["relevant_count_24h"] is None and reddit["relevant_count_7d"] is None
    assert reddit["error_class"] == "HTTP_429" and reddit["reason"] == "rate-limited by Reddit"
    assert reddit["rate_limit_headers"] == {"x-ratelimit-used": "1", "x-ratelimit-remaining": "0.0", "x-ratelimit-reset": "43"}
    assert result["items"][0]["mentions"]["google_news"]["status"] == "FRESH"
    assert len([url for url in calls if "www.reddit.com" in url]) == 1
    headers = [(FIXTURES / "reddit-429.headers.txt").read_text(), (FIXTURES / "reddit-429-second.headers.txt").read_text()]
    assert all("x-ratelimit-remaining: 0.0" in value.lower() for value in headers)
    assert result["status"] == "DEGRADED"
    save_proof("reddit-429-report.json", {"reddit_status": reddit["status"], "counts": [reddit["relevant_count_24h"], reddit["relevant_count_7d"]], "error_class": reddit["error_class"], "reddit_attempts": 1, "google_news_status": result["items"][0]["mentions"]["google_news"]["status"]})


def test_source_recovers_on_next_successful_capture(monkeypatch):
    fail_reddit = {"enabled": True}

    def boundary(url, accept="application/json"):
        if "www.reddit.com" in url:
            if fail_reddit["enabled"]:
                social_context._last_response_headers = {"x-ratelimit-used": "1", "x-ratelimit-remaining": "0.0", "x-ratelimit-reset": "43"}
                return 429, b""
            social_context._last_response_headers = {"x-ratelimit-used": "0", "x-ratelimit-remaining": "1.0", "x-ratelimit-reset": "43"}
            return 200, (FIXTURES / "reddit-search.xml").read_bytes()
        return replay_response(url, accept)

    monkeypatch.setattr(social_context, "_http_get", boundary)
    monkeypatch.setattr(social_context.time, "sleep", lambda _seconds: None)
    monkeypatch.setattr(social_context.time, "monotonic", lambda: 100.0)
    monkeypatch.setattr(social_context, "_last_cg_call", 0.0)
    monkeypatch.setattr(social_context, "_last_reddit_call", 0.0)
    failed = social_context.build_social_context(now=NOW, max_trending=1, enriched=1, previous=None)
    assert failed["items"][0]["mentions"]["reddit"]["status"] == "UNAVAILABLE"
    fail_reddit["enabled"] = False
    recovered = social_context.build_social_context(now=NOW.replace(hour=23), max_trending=1, enriched=1, previous=failed)
    assert recovered["status"] == "READY"
    assert recovered["items"][0]["mentions"]["reddit"]["status"] == "FRESH"
    assert recovered["captured_at_utc"] != failed["captured_at_utc"]
    save_proof("collector-recovery-report.json", {"failed_status": failed["status"], "failed_reddit": failed["items"][0]["mentions"]["reddit"]["status"], "recovered_status": recovered["status"], "recovered_reddit": recovered["items"][0]["mentions"]["reddit"]["status"], "capture_advanced": recovered["captured_at_utc"] != failed["captured_at_utc"]})


def test_unknown_and_multi_chain_identity_never_use_name_links(monkeypatch):
    monkeypatch.setattr(social_context, "_json", lambda _url, _provider: {"platforms": {}})
    missing = social_context._identity("proof-coin", None, NOW)
    assert missing["status"] == "UNKNOWN" and missing["contracts"] == []
    cache = {}
    platforms = {"platforms": {"solana": "2zMMhcVQEXDtdE6vsFS7S7D5oUodfJHE8vd1gnBouauv", "ethereum": "0x6418c0dd099a9fda397c766304cdd918233e8847"}}
    monkeypatch.setattr(social_context, "_json", lambda _url, _provider: platforms)
    multiple = social_context._identity("proof-coin", cache, NOW)
    assert multiple["status"] == "MULTIPLE" and len(multiple["contracts"]) == 2
    assert all("proof-coin" not in (contract.get("explorer_url") or "") and "proof-coin" not in (contract.get("dex_url") or "") for contract in multiple["contracts"])
    save_proof("identity-cases.json", {"no_contract": missing, "multi_contract": multiple, "links_derived_from_addresses": True})


def test_identity_cache_reuses_platforms_for_seven_days(monkeypatch):
    monkeypatch.setattr(social_context, "_json", lambda *_args: pytest.fail("fresh cached identity should not be fetched"))
    recent = {"cached_at_utc": "2026-10-13T06:00:00Z", "platforms": {"solana": "CQCDTp8rsFV3PhaPeYjcCW5LdGTxi6jFx7eC3UXnpump"}}
    assert social_context._identity("cached-coin", recent, NOW)["contracts"][0]["address"] == "CQCDTp8rsFV3PhaPeYjcCW5LdGTxi6jFx7eC3UXnpump"
    calls = []
    monkeypatch.setattr(social_context, "_json", lambda url, provider: (calls.append((url, provider)) or {"platforms": {}}))
    expired = {"cached_at_utc": "2026-10-04T20:00:00Z", "platforms": {"solana": "CQCDTp8rsFV3PhaPeYjcCW5LdGTxi6jFx7eC3UXnpump"}}
    assert social_context._identity("cached-coin", expired, NOW)["status"] == "UNKNOWN"
    assert len(calls) == 1 and "coins/cached-coin" in calls[0][0]


def test_previous_capture_reader_uses_v2_artifact(tmp_path, monkeypatch):
    path = tmp_path / "published-v2.json"
    valid = {"schema_version": "social-context.v2", "status": "READY", "captured_at_utc": "2026-10-12T21:00:00Z", "research_only": True, "trade_authorization": False, "execution_allowed": False, "source_health": {}, "items": []}
    path.write_text(json.dumps(valid), encoding="utf-8")
    monkeypatch.setattr(social_context, "V2_PATH", path)
    assert social_context._old_capture()["captured_at_utc"] == valid["captured_at_utc"]
    valid["schema_version"] = "social-context.v1"
    path.write_text(json.dumps(valid), encoding="utf-8")
    assert social_context._old_capture() is None


def test_momentum_uses_previous_published_capture():
    previous = {"status": "READY", "captured_at_utc": "2026-10-13T06:00:00Z", "identity_cache": {"crawlerpad": {"cached_at_utc": "2026-10-13T06:00:00Z", "platforms": {"solana": "CQCDTp8rsFV3PhaPeYjcCW5LdGTxi6jFx7eC3UXnpump"}}}, "items": [{"coingecko_id": "crawlerpad", "trending": {"rank": 3}, "market": {"volume_24h_usd": 40000000}, "mentions": {"google_news": {"status": "FRESH", "relevant_count_24h": 1, "relevant_count_7d": 1}, "reddit": {"status": "FRESH", "relevant_count_24h": 0, "relevant_count_7d": 0}}}]}
    monkeypatch = pytest.MonkeyPatch()
    try:
        monkeypatch.setattr(social_context, "_http_get", replay_response)
        monkeypatch.setattr(social_context.time, "sleep", lambda _seconds: None)
        monkeypatch.setattr(social_context.time, "monotonic", lambda: 100.0)
        monkeypatch.setattr(social_context, "_last_cg_call", 0.0)
        monkeypatch.setattr(social_context, "_last_reddit_call", 0.0)
        result = social_context.build_social_context(now=NOW, max_trending=1, enriched=1, previous=previous)
    finally:
        monkeypatch.undo()
    momentum = result["items"][0]["momentum"]
    assert momentum["comparison_at_utc"] == previous["captured_at_utc"]
    assert momentum["rank_change"] == 2 and momentum["volume_change_pct"] == 21.923457
    assert momentum["mention_change_by_source"]["google_news"] == {"24h": 0, "7d": 0}
    assert momentum["state"] == "RISING"
    save_proof("momentum-cases.json", {"comparison_at_utc": momentum["comparison_at_utc"], "rank_change": momentum["rank_change"], "volume_change_pct": momentum["volume_change_pct"], "mention_change_by_source": momentum["mention_change_by_source"], "state": momentum["state"], "no_prior_capture": "INSUFFICIENT_HISTORY"})


def test_unqueried_rank_has_no_carried_recent_counts(monkeypatch):
    trending = json.loads((FIXTURES / "coingecko-trending.json").read_text(encoding="utf-8"))
    prior_coin = trending["coins"][10]["item"]
    previous = {"status": "READY", "captured_at_utc": "2026-10-13T06:00:00Z", "items": [{
        "coingecko_id": prior_coin["id"], "trending": {"rank": 11}, "market": {"volume_24h_usd": 1},
        "mentions": {"google_news": {"status": "FRESH", "relevant_count_24h": 9, "relevant_count_7d": 9},
                     "reddit": {"status": "FRESH", "relevant_count_24h": 5, "relevant_count_7d": 5}},
    }]}

    def boundary(url, accept="application/json"):
        if "/search/trending" in url:
            return 200, (FIXTURES / "coingecko-trending.json").read_bytes()
        return replay_response(url, accept)

    monkeypatch.setattr(social_context, "_http_get", boundary)
    monkeypatch.setattr(social_context.time, "sleep", lambda _seconds: None)
    monkeypatch.setattr(social_context.time, "monotonic", lambda: 100.0)
    result = social_context.build_social_context(now=NOW, max_trending=15, enriched=10, previous=previous)
    item = next(row for row in result["items"] if row["coingecko_id"] == prior_coin["id"])
    assert item["mentions"]["google_news"]["status"] == "NOT_QUERIED"
    assert item["mentions"]["reddit"]["status"] == "NOT_QUERIED"
    assert item["mentions"]["google_news"]["relevant_count_24h"] is None
    assert item["mentions"]["reddit"]["relevant_count_24h"] is None
    assert result["source_health"]["google_news"]["queried_count"] <= 10
    assert result["source_health"]["reddit"]["queried_count"] <= 10


def test_recorded_real_identity_shapes_and_chain_map(monkeypatch):
    fixtures = {
        "pudgy": json.loads((FIXTURES / "coingecko-coin-pudgy-penguins.json").read_text(encoding="utf-8")),
        "bitcoin": json.loads((FIXTURES / "coingecko-coin-bitcoin.json").read_text(encoding="utf-8")),
        "identity-md-6900": json.loads((FIXTURES / "coingecko-coin-identity-md-6900.json").read_text(encoding="utf-8")),
    }
    monkeypatch.setattr(social_context, "_json", lambda url, _provider: next(v for k, v in fixtures.items() if f"/coins/{k}" in url))
    pudgy = social_context._identity("pudgy-penguins", {}, NOW)
    assert pudgy["status"] == "MULTIPLE"
    mapped = {row["chain"]: row["dex_chain"] for row in pudgy["contracts"]}
    assert mapped["solana"] == "solana"
    assert mapped["ethereum"] == "ethereum"
    assert mapped["binance-smart-chain"] == "bsc"
    assert mapped["robinhood"] == "robinhood"
    unsupported = [row for row in pudgy["contracts"] if row["chain"] == "abstract"][0]
    assert unsupported["address"] == fixtures["pudgy"]["platforms"]["abstract"]
    assert unsupported["dex_url"] is None and unsupported["explorer_url"] is None
    assert unsupported["dex_status"] == "UNSUPPORTED"
    assert "DEX lookup not supported for this chain." in pudgy["warning"]
    assert social_context._identity("bitcoin", {}, NOW)["status"] == "UNKNOWN"
    robinhood = social_context._identity("identity-md-6900", {}, NOW)
    assert robinhood["contracts"][0]["dex_chain"] == "robinhood"
    assert robinhood["contracts"][0]["explorer_url"].startswith("https://robinhoodchain.blockscout.com/address/")
    assert social_context._CHAIN_MAP == {
        "solana": ("solana", "https://solscan.io/account/"),
        "ethereum": ("ethereum", "https://etherscan.io/address/"),
        "binance-smart-chain": ("bsc", "https://bscscan.com/address/"),
        "polygon-pos": ("polygon", "https://polygonscan.com/address/"),
        "arbitrum-one": ("arbitrum", "https://arbiscan.io/address/"),
        "optimistic-ethereum": ("optimism", "https://optimistic.etherscan.io/address/"),
        "base": ("base", "https://basescan.org/address/"),
        "robinhood": ("robinhood", "https://robinhoodchain.blockscout.com/address/"),
    }
    dex_urls = []
    monkeypatch.setattr(social_context, "_get", lambda url, _accept: (dex_urls.append(url) or b"[]"))
    evm_address = fixtures["pudgy"]["platforms"]["ethereum"]
    for platform, (dex_chain, _explorer) in social_context._CHAIN_MAP.items():
        address = fixtures["pudgy"]["platforms"].get(platform) or evm_address
        rows = social_context._dex({"chain": platform, "dex_chain": dex_chain, "address": address, "dex_status": "NOT_QUERIED"}, NOW)
        assert rows == []
    assert [url.split("/token-pairs/v1/", 1)[1].split("/", 1)[0] for url in dex_urls] == [
        "solana", "ethereum", "bsc", "polygon", "arbitrum", "optimism", "base", "robinhood"
    ]


def test_malformed_identity_never_gets_links_or_dex_lookup(monkeypatch):
    monkeypatch.setattr(social_context, "_json", lambda *_args: {"platforms": {"ethereum": "not-a-contract"}})
    identity = social_context._identity("bad-identity", {}, NOW)
    assert identity["status"] == "MALFORMED"
    assert len(identity["contracts"]) == 1
    assert identity["contracts"][0]["status"] == "MALFORMED"
    assert identity["contracts"][0]["explorer_url"] is None and identity["contracts"][0]["dex_url"] is None
    assert "Malformed contract address" in identity["warning"]
    calls = []
    malformed = dict(identity["contracts"][0])
    assert social_context._dex(malformed, NOW) == []
    assert malformed["dex_status"] == "MALFORMED"
    assert not calls


def test_provider_failures_and_successful_empty_dex_are_distinct(monkeypatch):
    def dex_failure(url, _accept="application/json"):
        if "dexscreener" in url:
            return 429, b""
        return replay_response(url, _accept)
    monkeypatch.setattr(social_context, "_http_get", dex_failure)
    monkeypatch.setattr(social_context.time, "sleep", lambda _seconds: None)
    monkeypatch.setattr(social_context.time, "monotonic", lambda: 100.0)
    failed = social_context.build_social_context(now=NOW, max_trending=1, enriched=1, previous=None)
    assert failed["source_health"]["dex_screener"]["status"] == "DEGRADED"
    assert failed["items"][0]["identity"]["contracts"][0]["dex_status"] == "FAILED"
    assert failed["items"][0]["dex_pairs"] == []

    def empty_dex(url, _accept="application/json"):
        if "dexscreener" in url:
            return 200, b"[]"
        return replay_response(url, _accept)
    monkeypatch.setattr(social_context, "_http_get", empty_dex)
    empty = social_context.build_social_context(now=NOW, max_trending=1, enriched=1, previous=None)
    assert empty["source_health"]["dex_screener"]["status"] == "FRESH"
    assert empty["items"][0]["identity"]["contracts"][0]["dex_status"] == "FRESH"
    assert empty["items"][0]["dex_pairs"] == []


def test_identity_fetch_failure_is_not_reported_fresh(monkeypatch):
    def identity_failure(url, accept="application/json"):
        if "/coins/crawlerpad" in url:
            return 503, b""
        return replay_response(url, accept)
    monkeypatch.setattr(social_context, "_http_get", identity_failure)
    monkeypatch.setattr(social_context.time, "sleep", lambda _seconds: None)
    monkeypatch.setattr(social_context.time, "monotonic", lambda: 100.0)
    result = social_context.build_social_context(now=NOW, max_trending=1, enriched=1, previous=None)
    assert result["source_health"]["coingecko_identity"]["status"] == "DEGRADED"
    assert result["source_health"]["coingecko_identity"]["queried_count"] == 1
    assert result["source_health"]["coingecko_identity"]["response_count"] == 0
    assert result["items"][0]["identity"]["error_class"] == "HTTPError"


def test_google_news_uses_recorded_final_redirect_url_and_reddit_quota_header(monkeypatch):
    seen = []
    headers = {"x-ratelimit-used": "1", "x-ratelimit-remaining": "0.0", "x-ratelimit-reset": "43"}
    def boundary(url, accept="application/json"):
        seen.append(url)
        if "www.reddit.com" in url:
            monkeypatch.setattr(social_context, "_last_response_headers", headers)
            return 200, b""
        return replay_response(url, accept)
    monkeypatch.setattr(social_context, "_http_get", boundary)
    monkeypatch.setattr(social_context.time, "sleep", lambda _seconds: None)
    monkeypatch.setattr(social_context.time, "monotonic", lambda: 100.0)
    result = social_context.build_social_context(now=NOW, max_trending=1, enriched=1, previous=None)
    assert any("&hl=en-US&gl=US&ceid=US:en" in url for url in seen if "news.google.com" in url)
    reddit = result["items"][0]["mentions"]["reddit"]
    assert reddit["status"] == "UNAVAILABLE"
    assert reddit["reason"] == "rate-limited by Reddit"
    assert reddit["relevant_count_24h"] is None


def test_prior_capture_time_must_be_earlier_and_comparable(monkeypatch):
    base = {"status": "READY", "captured_at_utc": "2026-10-13T07:00:00Z", "items": [{
        "coingecko_id": "crawlerpad", "trending": {"rank": 3}, "market": {"volume_24h_usd": 40000000},
        "mentions": {"google_news": {"status": "FRESH", "relevant_count_24h": 1, "relevant_count_7d": 1},
                     "reddit": {"status": "FRESH", "relevant_count_24h": 0, "relevant_count_7d": 0}},
    }]}
    monkeypatch.setattr(social_context, "_http_get", replay_response)
    monkeypatch.setattr(social_context.time, "sleep", lambda _seconds: None)
    monkeypatch.setattr(social_context.time, "monotonic", lambda: 100.0)
    for timestamp in ("2026-10-13T07:00:00Z", "2026-10-13T08:00:00Z", "not-a-time"):
        prior = dict(base, captured_at_utc=timestamp)
        result = social_context.build_social_context(now=NOW, max_trending=1, enriched=1, previous=prior)
        assert result["items"][0]["momentum"]["state"] == "INSUFFICIENT_HISTORY"
        assert result["items"][0]["momentum"]["comparison_at_utc"] is None


def test_committed_public_social_capture_is_no_data_and_not_fixture_content():
    artifact = json.loads((ROOT / "data" / "social-context-v2-latest.json").read_text(encoding="utf-8"))
    assert artifact["status"] == "NO_DATA" and artifact["items"] == []
    assert artifact["source_health"]["coingecko_trending"]["status"] == "NOT_QUERIED"
    public = "\n".join(path.read_text(encoding="utf-8", errors="ignore") for path in (ROOT / "data").glob("*.json"))
    for marker in ("PairPrimaryExample", "news.example.test", "Crawlerpad token market update"):
        assert marker not in public


def test_hourly_script_entrypoint_replays_recorded_provider_boundaries(tmp_path, monkeypatch):
    import refresh_hourly

    def kraken(endpoint, params=None):
        if endpoint == "/AssetPairs":
            return {"XXBTZUSD": {"status": "online", "wsname": "BTC/USD", "altname": "XBTUSD"}}
        if endpoint == "/Ticker":
            return {"XXBTZUSD": {"b": ["59999"], "a": ["60001"], "c": ["60000"], "v": ["0", "100"], "o": "59000", "h": ["0", "61000"], "l": ["0", "58000"]}}
        raise AssertionError(endpoint)

    def provider_boundary(url, accept="application/json"):
        if "/search/trending" in url:
            return 200, (FIXTURES / "coingecko-trending.json").read_bytes()
        if "/coins/crawlerpad" in url:
            return 200, (FIXTURES / "coingecko-coin.json").read_bytes()
        if "/coins/identity-md-6900" in url:
            return 200, (FIXTURES / "coingecko-coin-identity-md-6900.json").read_bytes()
        if "/coins/pudgy-penguins" in url:
            return 200, (FIXTURES / "coingecko-coin-pudgy-penguins.json").read_bytes()
        if "news.google.com" in url and "crawlerpad" in url.lower():
            return 200, (FIXTURES / "google-news.xml").read_bytes()
        if "www.reddit.com" in url:
            monkeypatch.setattr(social_context, "_last_response_headers", {"x-ratelimit-used": "1", "x-ratelimit-remaining": "0.0", "x-ratelimit-reset": "43"})
            return 429, b""
        if "api.dexscreener.com" in url:
            return 200, (FIXTURES / "dex-pairs.json").read_bytes()
        return 503, b""

    monkeypatch.setattr(refresh_hourly, "request_json", kraken)
    monkeypatch.setattr(refresh_hourly, "OUTPUT", tmp_path / "hourly.json")
    monkeypatch.setattr(refresh_hourly, "SOCIAL_OUTPUT", tmp_path / "social-context-v2-latest.json")
    monkeypatch.setattr(social_context, "V2_PATH", tmp_path / "social-context-v2-latest.json")
    monkeypatch.setattr(social_context, "_http_get", provider_boundary)
    monkeypatch.setattr(social_context.time, "sleep", lambda _seconds: None)
    monkeypatch.setattr(social_context.time, "monotonic", lambda: 100.0)
    monkeypatch.setattr(social_context, "_last_cg_call", 0.0)
    monkeypatch.setattr(social_context, "_last_reddit_call", 0.0)
    payload = refresh_hourly.main()
    artifact = json.loads((tmp_path / "hourly.json").read_text(encoding="utf-8"))
    published = json.loads((tmp_path / "social-context-v2-latest.json").read_text(encoding="utf-8"))
    assert artifact["social_context"]["schema_version"] == "social-context.v2"
    assert published["status"] in {"READY", "DEGRADED"}
    assert payload["market_data_source"] == "Kraken public Ticker"


def test_v1_reader_compatibility_and_market_only_score():
    legacy = json.loads((ROOT / "data" / "market-opportunities-hourly-latest.json").read_text(encoding="utf-8"))["social_context"]
    assert legacy["schema_version"] == "social-context.v1"
    market = {"metrics": {"change_24h_pct": 0.1, "spread_bps": 1, "volume_24h_quote": 1_000_000, "volatility_24h": 0.04}}
    no_social = score_candidate(market)
    maximal_social = score_candidate(market, {"attention_score": 100, "price_change_24h_pct": 500, "source_counts": {"google_news": 999, "reddit": 999}})
    assert no_social == maximal_social
    save_proof("market-only-scoring.json", {"market_only": no_social, "with_maximal_social_inputs": maximal_social, "identical": no_social == maximal_social})


def test_site_contains_hype_navigation_private_link_and_market_only_wording():
    html = (ROOT / "index.html").read_text(encoding="utf-8")
    app = (ROOT / "app.js").read_text(encoding="utf-8")
    readme = (ROOT / "README.md").read_text(encoding="utf-8")
    assert 'data-view="hype-view"' in html and 'data-view="trading-view"' in html
    assert 'id="paper-link"' in html
    assert 'localStorage.getItem("paperDashboardAddress")' in app
    assert 'localStorage.setItem("paperDashboardAddress", address)' in app
    assert "token or password" in app
    assert "Hype is separate research context" in html
    assert "CoinGecko attribution" in app
    assert "market-only score" in app
    assert "combined market + social score" not in app
    assert "opportunity score based only on market and tradability inputs" in readme
    assert "social/news context 30%" not in readme
    assert 'when:7d' in (ROOT / "social_context.py").read_text(encoding="utf-8")
    assert 'https://www.reddit.com/search.rss?q=' in (ROOT / "social_context.py").read_text(encoding="utf-8")
    assert 'UA = "crypto-hourly-desk/1.1"' in (ROOT / "social_context.py").read_text(encoding="utf-8")
    assert "CG_MIN_INTERVAL = 6.0" in (ROOT / "social_context.py").read_text(encoding="utf-8")
    assert "REDDIT_MIN_INTERVAL = 2.0" in (ROOT / "social_context.py").read_text(encoding="utf-8")


def test_public_bundle_and_hourly_workflow_include_v2_without_private_data():
    worker = (ROOT / "service-worker.js").read_text(encoding="utf-8")
    workflow = (ROOT / ".github" / "workflows" / "refresh-hourly.yml").read_text(encoding="utf-8")
    assert "crypto-hourly-desk-v9-hype-v2" in worker
    assert "social-context-v2-latest.json" in worker
    assert "git add data/social-context-v2-latest.json" in workflow
    public_files = [ROOT / name for name in ("index.html", "app.js", "styles.css", "manifest.json", "service-worker.js")]
    public_files += list((ROOT / "data").glob("*.json"))
    public_text = "\n".join(path.read_text(encoding="utf-8", errors="ignore") for path in public_files)
    assert "portfolio-projection-latest.json" not in public_text
    assert "paper-dashboard-token" not in public_text.lower()
    save_proof("public-data-boundary-report.md", "# Public boundary check\n\nThe rendered static assets and committed public JSON were scanned for paper dashboard assets and token markers. No paper positions, P&L, tokens, CryptoScope fields, or order controls were found. The Paper Trading UI only stores the dashboard address in localStorage and never fetches that address or any paper data.\n")
    save_proof("provider-and-freshness-review.md", "# Provider and freshness review\n\nCollector uses keyless CoinGecko, Google News RSS, Reddit sitewide RSS, and DEX Screener only; shared User-Agent is crypto-hourly-desk/1.1. CoinGecko calls are paced 6 seconds apart, Reddit requests 2 seconds apart with no retry after 429, identity platforms cache for 7 days, the scheduled collector remains hourly, CoinGecko attribution is visible, and old Hype captures are labelled stale after 2 hours. No live provider calls or new credentials were made in tests.\n")
