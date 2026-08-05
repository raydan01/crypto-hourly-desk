import json
import sys
from pathlib import Path

ROOT = Path(__file__).parent
sys.path.insert(0, str(ROOT))
import social_context
from research.market_opportunities import score_candidate



def test_social_context_can_change_neutral_market_direction_and_score_is_bounded():
    item = {"metrics": {"change_24h_pct": 0.1, "spread_bps": 1, "volume_24h_quote": 1000000, "volatility_24h": 0.04}}
    result = score_candidate(item, {"attention_score": 90, "price_change_24h_pct": 4, "source_counts": {"google_news": 10, "reddit": 5}})
    assert result["bias"] == "LONG_RESEARCH"
    assert 0 <= result["score"] <= 100


def test_social_source_retries_transient_failures_three_times(monkeypatch):
    attempts = []
    monkeypatch.setattr(social_context, "sleep", lambda _seconds: None)

    def flaky_source():
        attempts.append(len(attempts) + 1)
        if len(attempts) < 3:
            raise TimeoutError("temporary source outage")
        return "recovered"

    assert social_context._with_retries(flaky_source) == "recovered"
    assert attempts == [1, 2, 3]


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
    assert "REQUEST_RETRY_DELAYS_MS = [300, 1000, 2500]" in app
    assert "refreshAllSnapshots" in app
    assert "refreshAllLiveQuotes" in app
    assert "All schedules refreshed" in app
    assert "up to 3 attempts per source" in app
    assert "social/news artifact captured" in app
    assert "const allChoices = snapshot.candidates || []" in app
    assert "const displayPriority = {LONG_RESEARCH: 0, SHORT_RESEARCH: 1, AVOID: 2}" in app
    assert "orderDisplayChoices" in app
    assert 'item.bias = combinedDirection >= 0.25 ? "LONG_RESEARCH" : combinedDirection <= -0.25 ? "SHORT_RESEARCH" : "AVOID";' in app
    assert "FRESH_RESEARCH_ONLY" in app
    assert "BEARISH RESEARCH MAP" in app
    assert "market-opportunities-long-term-latest.json" in app
    assert "interval=${modeConfig[activeMode].interval}" in app


def test_mobile_desk_has_fail_closed_freshness_contract():
    app = (ROOT / "app.js").read_text(encoding="utf-8")
    worker = (ROOT / "service-worker.js").read_text(encoding="utf-8")
    refresh = (ROOT / "refresh_hourly.py").read_text(encoding="utf-8")
    assert "MAX_LIVE_QUOTE_AGE_SECONDS = 120" in app
    assert "DATA STALE" in app
    assert "live_quote_complete" in app
    assert "live_quote_failed_symbols" in app
    assert "last < low || last > high" in app
    assert "function buildUsdPairMap" in app
    assert 'if (quote !== "USD") continue' in app
    assert "const freshness = liveFreshness()" in app
    assert "fetchFreshJson(`https://api.kraken.com/0/public/Ticker" in app
    assert "Kraken returned an invalid USD quote range" in app
    assert 'item.margin_status === "verified_enabled"' in app
    assert "crypto-hourly-desk-v8-full-refresh" in worker
    assert "caches.delete(key)" in worker
    assert '"market_data_source"' in refresh
    assert '"freshness_contract"' in refresh
    assert "RETRY_DELAYS_SECONDS = (1, 3, 8)" in refresh


def test_refresh_pipeline_retries_social_sources_and_deploys_after_scheduled_refreshes():
    social = (ROOT / "social_context.py").read_text(encoding="utf-8")
    daily = (ROOT / "refresh_daily.py").read_text(encoding="utf-8")
    pages = (ROOT / ".github" / "workflows" / "pages.yml").read_text(encoding="utf-8")
    assert "MAX_ATTEMPTS = len(RETRY_DELAYS_SECONDS) + 1" in social
    assert "return _with_retries(operation)" in social
    assert "social = build_social_context()" in daily
    assert "social_context=social" in daily
    assert "workflow_run:" in pages
    assert "Refresh hourly market snapshot" in pages
    assert "Refresh weekly trading snapshot" in pages
    assert "conclusion == 'success'" in pages


def test_installed_refresh_wrappers_update_mobile_artifacts():
    hourly = (ROOT.parent / "jobs" / "run_market_opportunities_hourly_hidden.vbs").read_text(encoding="utf-8")
    daily = (ROOT.parent / "jobs" / "run_market_opportunities_daily_hidden.vbs").read_text(encoding="utf-8")
    assert "mobile-pwa/refresh_hourly.py" in hourly.replace("\\", "/")
    assert "mobile-pwa/refresh_daily.py" in daily.replace("\\", "/")
