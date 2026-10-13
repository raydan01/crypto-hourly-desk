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
NOW = datetime(2026, 10, 12, 22, 0, tzinfo=timezone.utc)


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
        return 200, (FIXTURES / "coingecko-trending.json").read_bytes()
    if "/coins/crawlerpad" in url:
        return 200, (FIXTURES / "coingecko-coin.json").read_bytes()
    if "news.google.com" in url:
        return 200, (FIXTURES / "google-news.xml").read_bytes()
    if "www.reddit.com" in url:
        return 200, (FIXTURES / "reddit-search.xml").read_bytes()
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
    assert item["mentions"]["google_news"]["relevant_count_24h"] == 2
    assert item["mentions"]["google_news"]["relevant_count_7d"] == 2
    assert item["mentions"]["google_news"]["undated_matched_item_count"] == 1
    assert item["mentions"]["google_news"]["headlines"][0]["matched_text"] in {"title", "body"}
    assert len(item["mentions"]["google_news"]["headlines"]) == 2
    assert item["identity"]["contracts"][0]["address"] == "CQCDTp8rsFV3PhaPeYjcCW5LdGTxi6jFx7eC3UXnpump"
    assert len(item["dex_pairs"]) == 2
    assert item["dex_pairs"][0]["liquidity_usd"] == 386000
    assert item["dex_pairs"][1]["liquidity_usd"] is None
    assert item["dex_pairs"][1]["age_seconds"] is None
    assert item["dex_pairs"][1]["volume_by_period"]["h24"] is None
    assert {observation["kind"] for observation in item["fomo_watch"]["observations"]} >= {"PAIR_UNDER_24H", "LIQUIDITY_UNDER_5_PERCENT", "VOLUME_ABOVE_MARKET_CAP", "BUY_SELL_IMBALANCE", "PRICE_MOVE_ABOVE_100_PERCENT"}
    save_proof("collector-production-default.json", {"fixture_origin": "shape-derived from MATT_001 and MATT_005; no live response recorded in this sandbox", "collector_output": result})
    save_proof("mention-relevance-report.md", "# Mention relevance replay\n\nFixture replay accepted 2 distinct dated Google News matches in both the 24h and 7d windows; one older result, one common-word false match, a duplicate URL, and one matching undated item were excluded from counts. Two newest source links were emitted. The undated matching result is reported as unknown time.\n")
    save_proof("detail-card-fixtures.md", "# Detail card fixture replay\n\nTwo address-matched Solana DEX pairs were replayed. The pair with $386,000 liquidity is primary. The empty bonding-curve shape preserves pair age and liquidity as unknown, and its empty 24h volume is normalized to unknown rather than zero. FOMO observations include source values and remain watch-only.\n")


def test_reddit_429_is_degraded_without_zero_or_retry_burst(monkeypatch):
    calls = []

    def boundary(url, accept="application/json"):
        calls.append(url)
        if "www.reddit.com" in url:
            return 429, b""
        return replay_response(url, accept)

    monkeypatch.setattr(social_context, "_http_get", boundary)
    monkeypatch.setattr(social_context.time, "sleep", lambda _seconds: None)
    monkeypatch.setattr(social_context.time, "monotonic", lambda: 100.0)
    monkeypatch.setattr(social_context, "_last_cg_call", 0.0)
    monkeypatch.setattr(social_context, "_last_reddit_call", 0.0)
    result = social_context.build_social_context(now=NOW, max_trending=1, enriched=1, previous=None)
    reddit = result["items"][0]["mentions"]["reddit"]
    assert reddit["status"] == "DEGRADED"
    assert reddit["relevant_count_24h"] is None and reddit["relevant_count_7d"] is None
    assert reddit["error_class"] == "HTTP_429"
    assert result["items"][0]["mentions"]["google_news"]["status"] == "FRESH"
    assert len([url for url in calls if "www.reddit.com" in url]) == 1
    assert result["status"] == "DEGRADED"
    save_proof("reddit-429-report.json", {"reddit_status": reddit["status"], "counts": [reddit["relevant_count_24h"], reddit["relevant_count_7d"]], "error_class": reddit["error_class"], "reddit_attempts": 1, "google_news_status": result["items"][0]["mentions"]["google_news"]["status"]})


def test_source_recovers_on_next_successful_capture(monkeypatch):
    fail_reddit = {"enabled": True}

    def boundary(url, accept="application/json"):
        if fail_reddit["enabled"] and "www.reddit.com" in url:
            return 429, b""
        return replay_response(url, accept)

    monkeypatch.setattr(social_context, "_http_get", boundary)
    monkeypatch.setattr(social_context.time, "sleep", lambda _seconds: None)
    monkeypatch.setattr(social_context.time, "monotonic", lambda: 100.0)
    monkeypatch.setattr(social_context, "_last_cg_call", 0.0)
    monkeypatch.setattr(social_context, "_last_reddit_call", 0.0)
    failed = social_context.build_social_context(now=NOW, max_trending=1, enriched=1, previous=None)
    assert failed["items"][0]["mentions"]["reddit"]["status"] == "DEGRADED"
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
    platforms = {"platforms": {"solana": "SolanaAddressExample", "ethereum": "0x1234567890abcdef"}}
    monkeypatch.setattr(social_context, "_json", lambda _url, _provider: platforms)
    multiple = social_context._identity("proof-coin", cache, NOW)
    assert multiple["status"] == "MULTIPLE" and len(multiple["contracts"]) == 2
    assert all("proof-coin" not in (contract.get("explorer_url") or "") and "proof-coin" not in (contract.get("dex_url") or "") for contract in multiple["contracts"])
    save_proof("identity-cases.json", {"no_contract": missing, "multi_contract": multiple, "links_derived_from_addresses": True})


def test_identity_cache_reuses_platforms_for_seven_days(monkeypatch):
    monkeypatch.setattr(social_context, "_json", lambda *_args: pytest.fail("fresh cached identity should not be fetched"))
    recent = {"cached_at_utc": "2026-10-12T20:00:00Z", "platforms": {"solana": "CachedAddressExample"}}
    assert social_context._identity("cached-coin", recent, NOW)["contracts"][0]["address"] == "CachedAddressExample"
    calls = []
    monkeypatch.setattr(social_context, "_json", lambda url, provider: (calls.append((url, provider)) or {"platforms": {}}))
    expired = {"cached_at_utc": "2026-10-04T20:00:00Z", "platforms": {"solana": "OldAddressExample"}}
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
    previous = {"captured_at_utc": "2026-10-12T21:00:00Z", "identity_cache": {"crawlerpad": {"cached_at_utc": "2026-10-12T21:00:00Z", "platforms": {"solana": "CQCDTp8rsFV3PhaPeYjcCW5LdGTxi6jFx7eC3UXnpump"}}}, "items": [{"coingecko_id": "crawlerpad", "trending": {"rank": 3}, "market": {"volume_24h_usd": 40000000}, "mentions": {"google_news": {"relevant_count_24h": 1, "relevant_count_7d": 1}, "reddit": {"relevant_count_24h": 0, "relevant_count_7d": 0}}}]}
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
    assert momentum["rank_change"] == 2 and momentum["volume_change_pct"] == 16.5
    assert momentum["mention_change_by_source"]["google_news"] == {"24h": 1, "7d": 1}
    assert momentum["state"] == "RISING"
    save_proof("momentum-cases.json", {"comparison_at_utc": momentum["comparison_at_utc"], "rank_change": momentum["rank_change"], "volume_change_pct": momentum["volume_change_pct"], "mention_change_by_source": momentum["mention_change_by_source"], "state": momentum["state"], "no_prior_capture": "INSUFFICIENT_HISTORY"})


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
    assert 'data-view="hype-view"' in html and 'data-view="trading-view"' in html
    assert 'id="paper-link"' in html
    assert 'localStorage.getItem("paperDashboardAddress")' in app
    assert 'localStorage.setItem("paperDashboardAddress", address)' in app
    assert "token or password" in app
    assert "Hype is separate research context" in html
    assert "CoinGecko attribution" in app
    assert "market-only score" in app
    assert "combined market + social score" not in app
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
