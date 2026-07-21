"""Read-only social and crypto-news context for the hourly mobile scan."""
from __future__ import annotations

import json
from datetime import datetime, timezone
from time import perf_counter
from urllib.parse import quote_plus
from urllib.request import Request, urlopen
import xml.etree.ElementTree as ET


def _json(url: str) -> dict:
    request = Request(url, headers={"Accept": "application/json", "User-Agent": "crypto-hourly-desk/1.1"})
    with urlopen(request, timeout=20) as response:
        value = json.loads(response.read().decode("utf-8"))
    if not isinstance(value, dict):
        raise RuntimeError("source returned an invalid response")
    return value


def _rss_count(url: str) -> int:
    request = Request(url, headers={"Accept": "application/rss+xml, application/atom+xml", "User-Agent": "crypto-hourly-desk/1.1"})
    with urlopen(request, timeout=15) as response:
        root = ET.fromstring(response.read())
    return len(root.findall(".//item")) + len(root.findall(".//{http://www.w3.org/2005/Atom}entry"))


def build_social_context(*, max_trending: int = 20, enriched: int = 10) -> dict:
    captured = datetime.now(timezone.utc).isoformat()
    health: dict[str, dict] = {}
    signals: dict[str, dict] = {}
    started = perf_counter()
    try:
        trending = list((_json("https://api.coingecko.com/api/v3/search/trending").get("coins") or []))[:max_trending]
        health["coingecko_trending"] = {"status": "FRESH", "coverage": min(100.0, len(trending) / max_trending * 100), "latency_ms": round((perf_counter() - started) * 1000, 1)}
    except Exception as exc:
        trending = []
        health["coingecko_trending"] = {"status": "FAILED", "coverage": 0.0, "failure_reason": type(exc).__name__}
    for row in trending[:enriched]:
        item = row.get("item") or {}
        symbol = str(item.get("symbol") or "").strip().upper()
        name = str(item.get("name") or symbol)
        if not symbol:
            continue
        signals[symbol] = {"name": name}
        for source, url in {
            "google_news": f"https://news.google.com/rss/search?q={quote_plus(f'crypto {name} OR {symbol}')}",
            "reddit": f"https://www.reddit.com/r/CryptoCurrency/search.rss?q={quote_plus(symbol)}&restrict_sr=1&sort=new",
        }.items():
            try:
                signals[symbol][source] = {"count": _rss_count(url)}
            except Exception as exc:
                signals[symbol][source] = {"count": 0, "status": "FAILED", "failure_reason": type(exc).__name__}
    for source in ("google_news", "reddit"):
        available = sum(1 for value in signals.values() if source in value and value[source].get("status") != "FAILED")
        coverage = round(available / max(1, min(enriched, len(signals))) * 100, 1)
        health[f"{source}_rss"] = {"status": "FRESH" if coverage == 100 else ("DEGRADED" if available else "FAILED"), "coverage": coverage}
    items = []
    for rank, row in enumerate(trending, start=1):
        item = row.get("item") or {}
        symbol = str(item.get("symbol") or "").strip().upper()
        if not symbol:
            continue
        signal = signals.get(symbol, {})
        news = int((signal.get("google_news") or {}).get("count", 0) or 0)
        reddit = int((signal.get("reddit") or {}).get("count", 0) or 0)
        sources = ["coingecko"] + [name for name in ("google_news", "reddit") if (signal.get(name) or {}).get("count", 0) > 0]
        score = min(100.0, round(max(0.0, 100.0 - (rank - 1) * 5.0) * 0.60 + min(news * 3.0, 20.0) + min(reddit * 2.0, 20.0) + min(10.0, (len(sources) - 1) * 5.0), 2))
        items.append({"rank": rank, "symbol": symbol, "name": str(item.get("name") or symbol), "attention_score": score, "sources": sources, "source_counts": {"google_news": news, "reddit": reddit}, "price_change_24h_pct": (item.get("data") or {}).get("price_change_percentage_24h", {}).get("usd")})
    return {"schema_version": "social-context.v1", "status": "READY" if items else "NO_DATA", "captured_at_utc": captured, "source_health": health, "source_status": {key: value["status"] for key, value in health.items()}, "method": "CoinGecko trending plus Google News RSS and Reddit RSS counts; context-only", "research_only": True, "trade_authorization": False, "execution_allowed": False, "items": items}
