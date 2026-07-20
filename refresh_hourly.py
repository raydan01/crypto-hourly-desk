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
API = "https://api.kraken.com/0/public"


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
    return build_opportunity_payload(scan, generated_at_utc=captured, cadence="hourly")


if __name__ == "__main__":
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps(build_snapshot(), sort_keys=True, separators=(",", ":")) + "\n", encoding="utf-8")
