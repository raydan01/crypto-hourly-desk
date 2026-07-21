"""Refresh the market-only hourly snapshot from Kraken public endpoints."""
from __future__ import annotations

import json
import math
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from research.market_opportunities import build_opportunity_payload, realized_volatility
from research.market_scanner import scan_markets

ROOT = Path(__file__).parent
OUTPUT = ROOT / "data" / "market-opportunities-hourly-latest.json"
WATCHLIST = ROOT / "data" / "watchlist.json"
API = "https://api.kraken.com/0/public"
NON_CRYPTO_SYMBOLS = {"USD", "GBP", "EUR", "CAD", "AUD", "JPY", "CHF"}


def request_json(endpoint: str, params: dict[str, str] | None = None) -> dict:
    url = f"{API}{endpoint}"
    if params:
        url += "?" + urlencode(params)
    request = Request(url, headers={"Accept": "application/json", "User-Agent": "crypto-hourly-desk/1.0"})
    with urlopen(request, timeout=30) as response:
        payload = json.load(response)
    if payload.get("error"):
        raise RuntimeError("Kraken public API returned an error")
    return payload.get("result") or {}


def number(value, default=None):
    try:
        result = float(value)
        return result if math.isfinite(result) else default
    except (TypeError, ValueError):
        return default


def eligible_pairs(asset_pairs: dict) -> dict[str, dict[str, str]]:
    result = {}
    for key, details in asset_pairs.items():
        if not isinstance(details, dict) or details.get("status") not in {None, "online"}:
            continue
        base, separator, quote = str(details.get("wsname", "")).partition("/")
        if not separator or quote != "USD" or not base or base.upper() == "MSTR":
            continue
        symbol = base.upper().replace("XBT", "BTC").replace("XDG", "DOGE")
        result.setdefault(symbol, {"pair_key": key, "altname": str(details.get("altname", key))})
    return result


def build_snapshot() -> dict:
    captured = datetime.now(timezone.utc).isoformat()
    pairs = eligible_pairs(request_json("/AssetPairs"))
    ticker = request_json("/Ticker", {"pair": ",".join(item["pair_key"] for item in pairs.values())})
    ranked = []
    for symbol, pair in pairs.items():
        row = ticker.get(pair["pair_key"]) or ticker.get(pair["altname"])
        if not isinstance(row, dict):
            continue
        bid = number((row.get("b") or [None])[0]); ask = number((row.get("a") or [None])[0])
        last = number((row.get("c") or [None])[0]); volume = number((row.get("v") or [None, None])[1])
        opening = number(row.get("o")); highs = row.get("h") or []; lows = row.get("l") or []
        high = number(highs[1] if len(highs) > 1 else None); low = number(lows[1] if len(lows) > 1 else None)
        if None in {bid, ask, last, volume} or min(bid, ask, last, volume) <= 0:
            continue
        volatility = (high - low) / opening if high and low and opening and high >= low and opening > 0 else None
        if volatility is None:
            continue
        ranked.append((volume * last, symbol, pair, bid, ask, last, volume, opening, high, low, volatility))
    ranked.sort(reverse=True)
    captured_rows = [{"symbol": symbol, "observed_at_utc": captured, "bid": bid, "ask": ask, "last": last, "high_24h": high, "low_24h": low, "volume_24h_quote": volume * last, "volatility_24h": volatility, "change_24h_pct": ((last / opening) - 1) * 100 if opening and opening > 0 else None, "pair_key": pair["pair_key"], "margin_status": "unknown"} for _, symbol, pair, bid, ask, last, volume, opening, high, low, volatility in ranked[:1000]]
    scan = scan_markets(list(pairs), captured_rows, observed_at_utc=captured)
    for candidate in scan.get("candidates", []):
        source = next((row for row in captured_rows if row["symbol"] == candidate["symbol"]), {})
        candidate["margin_status"] = source.get("margin_status", "unknown")
        candidate["metrics"]["change_24h_pct"] = source.get("change_24h_pct")
        candidate["pair_key"] = source.get("pair_key")
    watchlist = json.loads(WATCHLIST.read_text(encoding="utf-8"))
    watched_symbols = {str(item.get("symbol", "")).upper() for item in watchlist.get("assets", []) if item.get("category") == "crypto"}
    watched = [item for item in scan["candidates"] if item["symbol"] in watched_symbols]
    discovery = [item for item in scan["candidates"] if item["symbol"] not in watched_symbols and item["symbol"] not in NON_CRYPTO_SYMBOLS]
    selected_watched = watched[:16]
    selected_discovery = discovery[:4]
    for item in selected_watched:
        item["universe_bucket"] = "WATCHLIST"
    for item in selected_discovery:
        item["universe_bucket"] = "DISCOVERY"
    selected = selected_watched + selected_discovery
    focused_scan = {**scan, "candidates": selected}
    payload = build_opportunity_payload(focused_scan, generated_at_utc=captured, cadence="hourly")
    selected_symbols = {item["symbol"] for item in selected}
    rejected_watchlist = [item for item in scan.get("rejections", []) if str(item.get("symbol") or "").upper() in watched_symbols and str(item.get("symbol") or "").upper() not in selected_symbols]
    for rejection in rejected_watchlist[: max(0, 16 - len(selected_watched))]:
        symbol = str(rejection["symbol"]).upper()
        source = next((row for row in captured_rows if row["symbol"] == symbol), {})
        extra = {
            "symbol": symbol,
            "rank_score": 0,
            "rank": len(payload["candidates"]) + 1,
            "bias": "AVOID",
            "timeframe": "SHORT_TERM",
            "metrics": {"last": source.get("last"), "bid": source.get("bid"), "ask": source.get("ask"), "change_24h_pct": source.get("change_24h_pct"), "spread_bps": rejection.get("metrics", {}).get("spread_bps"), "volume_24h_quote": source.get("volume_24h_quote"), "volatility_24h": source.get("volatility_24h")},
            "margin_status": "unknown",
            "avoid_reason": rejection.get("reason", "QUALITY_SCREEN_REJECTED"),
            "universe_bucket": "WATCHLIST",
            "research_only": True,
            "trade_authorization": False,
            "execution_allowed": False,
            "explanation": {"market_quality": "failed one or more scan safeguards", "reason": rejection.get("reason", "QUALITY_SCREEN_REJECTED"), "quick_reason": "Watched coin retained for monitoring, but it did not pass the hourly quality screen."},
            "price_map": None,
        }
        payload["candidates"].append(extra)
    payload["candidates"] = [item for item in payload["candidates"] if item.get("universe_bucket") == "WATCHLIST"] + [item for item in payload["candidates"] if item.get("universe_bucket") == "DISCOVERY"]
    payload["selection_counts"] = {"watchlist_requested": 16, "watchlist_selected": min(16, len(selected_watched) + len(rejected_watchlist[: max(0, 16 - len(selected_watched))])), "discovery_requested": 4, "discovery_selected": len(selected_discovery)}
    payload["selection_policy"] = "16 highest-ranked watched coins plus 4 highest-ranked non-watchlist coins; failed watched coins remain visible as AVOID"
    return payload


if __name__ == "__main__":
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps(build_snapshot(), sort_keys=True, separators=(",", ":")) + "\n", encoding="utf-8")
