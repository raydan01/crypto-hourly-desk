import json
from pathlib import Path


ROOT = Path(__file__).parent


def test_mobile_package_has_installable_shell_and_hourly_snapshot():
    manifest = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["display"] == "standalone"
    assert manifest["icons"]
    assert (ROOT / "index.html").is_file()
    assert (ROOT / "service-worker.js").is_file()
    payload = json.loads((ROOT / "data" / "market-opportunities-hourly-latest.json").read_text(encoding="utf-8"))
    assert payload["cadence"] == "hourly"
    assert payload["execution_allowed"] is False
    assert payload["trade_authorization"] is False
    assert payload["selection_counts"]["watchlist_requested"] == 16
    assert payload["selection_counts"]["discovery_requested"] == 4
    assert len(payload["candidates"]) <= 20


def test_mobile_package_contains_no_private_dashboard_assets():
    names = {path.name for path in ROOT.iterdir()}
    assert "portfolio-projection-latest.json" not in names
    assert "risk-latest.json" not in names


def test_mobile_desk_has_manual_refresh_and_explains_research_only_state():
    html = (ROOT / "index.html").read_text(encoding="utf-8")
    app = (ROOT / "app.js").read_text(encoding="utf-8")
    assert 'id="refresh-button"' in html
    assert 'data-mode="hourly"' in html
    assert 'data-mode="daily"' in html
    assert 'data-mode="long-term"' in html
    assert 'addEventListener("click", () => boot({manual: true}))' in app
    assert "BULLISH SETUP" in app
    assert "BEARISH SETUP" in app
    assert "WATCH ONLY" in app
    assert "monitoring-only" in app
    assert "renderLongTerm" in app
    assert "const choices = (snapshot.candidates || []).slice(0, 20)" in app
    assert "No newer ${activeMode} snapshot yet" in app
