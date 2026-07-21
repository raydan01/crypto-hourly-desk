import json
from pathlib import Path

from research.market_opportunities import score_candidate


ROOT = Path(__file__).parent


def test_social_context_can_change_neutral_market_direction_and_score_is_bounded():
    item = {"metrics": {"change_24h_pct": 0.1, "spread_bps": 1, "volume_24h_quote": 1000000, "volatility_24h": 0.04}}
    result = score_candidate(item, {"attention_score": 90, "price_change_24h_pct": 4, "source_counts": {"google_news": 10, "reddit": 5}})
    assert result["bias"] == "LONG_RESEARCH"
    assert 0 <= result["score"] <= 100


def test_mobile_package_has_installable_shell_and_hourly_snapshot():
    manifest = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["display"] == "standalone"
    assert manifest["icons"]
    assert (ROOT / "index.html").is_file()
    assert (ROOT / "service-worker.js").is_file()
    assert (ROOT / "data" / "market-opportunities-daily-latest.json").is_file()
    assert (ROOT / "data" / "market-opportunities-long-term-latest.json").is_file()
    payload = json.loads((ROOT / "data" / "market-opportunities-hourly-latest.json").read_text(encoding="utf-8"))
    assert payload["cadence"] == "hourly"
    assert payload["execution_allowed"] is False
    assert payload["trade_authorization"] is False
    assert payload["social_context"]["research_only"] is True
    assert payload["social_context"]["trade_authorization"] is False
    scores = [item["opportunity_score"] for item in payload["candidates"]]
    assert scores == sorted(scores, reverse=True)
    assert all(0 <= score <= 100 for score in scores)
    assert payload["selection_counts"]["watchlist_requested"] == 16
    assert payload["selection_counts"]["discovery_requested"] == 4
    assert len(payload["candidates"]) <= 20
    for filename, timeframe in (("market-opportunities-daily-latest.json", "MEDIUM_LONG_TERM"), ("market-opportunities-long-term-latest.json", "LONG_TERM")):
        horizon = json.loads((ROOT / "data" / filename).read_text(encoding="utf-8"))
        assert horizon["candidates"]
        assert all("opportunity_score" in item and item["timeframe"] == timeframe for item in horizon["candidates"])


def test_mobile_package_contains_no_private_dashboard_assets():
    names = {path.name for path in ROOT.iterdir()}
    assert "portfolio-projection-latest.json" not in names
    assert "risk-latest.json" not in names


def test_mobile_desk_has_manual_refresh_and_explains_research_only_state():
    html = (ROOT / "index.html").read_text(encoding="utf-8")
    app = (ROOT / "app.js").read_text(encoding="utf-8")
    assert 'id="refresh-button"' in html
    assert 'id="deep-scan-button"' in html
    assert 'data-mode="hourly"' in html
    assert 'data-mode="daily"' in html
    assert 'data-mode="long-term"' in html
    assert 'addEventListener("click", () => boot({manual: true}))' in app
    assert "BULLISH SETUP" in app
    assert "BEARISH SETUP" in app
    assert "WATCH ONLY" in app
    assert "monitoring-only" in app
    assert "renderLongTerm" in app
    assert "refreshLiveQuotes" in app
    assert "Live Kraken quotes updated" in app
    assert "runDeepScan" in app
    assert "renderSocial" in app
    assert "combined market + social score" in app
    assert "opportunity_score" in app
    assert "Top shorts" in html
    assert "activeDirection" in app
    assert "CoinGecko" in html
    assert "OHLC" in app
    assert "cache-busted no-store request" in app
    assert "DEEP_SCAN_MIN_MS = 15000" in app
    assert "deep_scan_duration_seconds" in app
    assert "recalculateLiveRanking" in app
    assert "social/news artifact captured" in app
    assert "const allChoices = snapshot.candidates || []" in app
    assert "market-opportunities-long-term-latest.json" in app
    assert "interval=${modeConfig[activeMode].interval}" in app
