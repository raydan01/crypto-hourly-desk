"""Hourly, public social and market context collector (social-context.v2)."""
from __future__ import annotations

import json
import re
import time
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import quote, quote_plus, urlsplit
from urllib.request import Request, urlopen

UA = "crypto-hourly-desk/1.1"
ROOT = Path(__file__).parent
V2_PATH = ROOT / "data" / "social-context-v2-latest.json"
RETRY_DELAYS_SECONDS = (2, 5)
MAX_TRENDING = 20
MAX_ENRICHED = 10
CG_MIN_INTERVAL = 6.0
REDDIT_MIN_INTERVAL = 2.0
_last_cg_call = 0.0
_last_reddit_call = 0.0
_CHAIN_EXPLORERS = {
    "solana": ("https://solscan.io/account/", "solana"),
    "ethereum": ("https://etherscan.io/address/", "ethereum"),
    "binance-smart-chain": ("https://bscscan.com/address/", "bsc"),
    "base": ("https://basescan.org/address/", "base"),
    "arbitrum-one": ("https://arbiscan.io/address/", "arbitrum"),
    "polygon-pos": ("https://polygonscan.com/address/", "polygon"),
    "avalanche": ("https://snowtrace.io/address/", "avalanche"),
    "optimistic-ethereum": ("https://optimistic.etherscan.io/address/", "optimism"),
    "robinhood": ("https://explorer.robinhoodchain.com/address/", "robinhood"),
}


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _http_get(url: str, accept: str = "application/json") -> tuple[int, bytes]:
    request = Request(url, headers={"Accept": accept, "User-Agent": UA})
    try:
        with urlopen(request, timeout=20) as response:
            return int(response.status), response.read()
    except HTTPError as exc:
        return int(exc.code), exc.read()


def _pace(provider: str) -> None:
    global _last_cg_call, _last_reddit_call
    if provider == "coingecko":
        delay = CG_MIN_INTERVAL - (time.monotonic() - _last_cg_call)
        if _last_cg_call and delay > 0:
            time.sleep(delay)
        _last_cg_call = time.monotonic()
    elif provider == "reddit":
        delay = REDDIT_MIN_INTERVAL - (time.monotonic() - _last_reddit_call)
        if _last_reddit_call and delay > 0:
            time.sleep(delay)
        _last_reddit_call = time.monotonic()


def _get(url: str, accept: str, provider: str | None = None):
    last_error = None
    attempts = 1 if provider == "reddit" else len(RETRY_DELAYS_SECONDS) + 1
    for attempt in range(attempts):
        if provider:
            _pace(provider)
        try:
            status, body = _http_get(url, accept)
            if status == 429:
                raise HTTPError(url, status, "rate limited", {}, None)
            if status < 200 or status >= 300:
                raise HTTPError(url, status, "source unavailable", {}, None)
            return body
        except Exception as exc:
            last_error = exc
            if isinstance(exc, HTTPError) and exc.code == 429:
                break
            if attempt >= attempts - 1:
                break
            time.sleep(RETRY_DELAYS_SECONDS[attempt])
    raise last_error or RuntimeError("source unavailable")


def _json(url: str, provider: str | None = None) -> dict:
    value = json.loads(_get(url, "application/json", provider).decode("utf-8"))
    if not isinstance(value, dict):
        raise ValueError("invalid JSON object")
    return value


def _timestamp(raw: str | None) -> datetime | None:
    if not raw:
        return None
    try:
        try:
            parsed = parsedate_to_datetime(raw)
        except (TypeError, ValueError, OverflowError):
            parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            return None
        return parsed.astimezone(timezone.utc)
    except (TypeError, ValueError, OverflowError):
        return None


def _number(value):
    if isinstance(value, (int, float)):
        return value
    if not isinstance(value, str):
        return None
    text = value.strip().replace(",", "").replace("$", "")
    match = re.fullmatch(r"(-?\d+(?:\.\d+)?)\s*([KMB])?", text, re.IGNORECASE)
    if not match:
        return None
    scale = {None: 1, "K": 1e3, "M": 1e6, "B": 1e9}[match.group(2).upper() if match.group(2) else None]
    return float(match.group(1)) * scale


def _rss_items(data: bytes) -> list[dict]:
    root = ET.fromstring(data)
    output = []
    atom = "{http://www.w3.org/2005/Atom}"
    for item in root.findall(".//item"):
        output.append({"title": item.findtext("title") or "", "url": item.findtext("link") or "", "published": item.findtext("pubDate"), "body": item.findtext("description") or ""})
    for entry in root.findall(f".//{atom}entry"):
        links = entry.findall(f"{atom}link")
        published = entry.findtext(f"{atom}published") or entry.findtext(f"{atom}updated")
        output.append({"title": entry.findtext(f"{atom}title") or "", "url": next((link.get("href", "") for link in links if link.get("rel", "alternate") == "alternate"), ""), "published": published, "body": entry.findtext(f"{atom}summary") or entry.findtext(f"{atom}content") or ""})
    return output


def _contains(text: str, phrase: str) -> bool:
    phrase = phrase.strip()
    if not phrase:
        return False
    # Unicode letters/numbers and underscore are word characters; phrases may contain spaces.
    return re.search(r"(?<![\w])" + re.escape(phrase) + r"(?![\w])", text, re.IGNORECASE) is not None


def _match(item: dict, name: str, symbol: str) -> str | None:
    title = item["title"]
    body = item.get("body") or ""
    symbol_pattern = r"(?<![\w])\$" + re.escape(symbol) + r"(?![\w])" if symbol else None
    for where, text in (("title", title), ("body", body)):
        if _contains(text, name) or (symbol_pattern and re.search(symbol_pattern, text, re.IGNORECASE)):
            return where
    return None


def _mentions(source: str, name: str, symbol: str, now: datetime) -> dict:
    quoted_name = f'"{name}" when:7d'
    if source == "google_news":
        url = "https://news.google.com/rss/search?q=" + quote_plus(quoted_name)
        accept = "application/rss+xml, application/atom+xml"
        provider = None
    else:
        url = "https://www.reddit.com/search.rss?q=" + quote_plus(f'"{name}"') + "&sort=new"
        accept = "application/rss+xml, application/atom+xml"
        provider = "reddit"
    try:
        items = _rss_items(_get(url, accept, provider))
    except Exception as exc:
        return {"status": "DEGRADED", "query_at_utc": _iso(now), "relevant_count_24h": None, "relevant_count_7d": None, "newest_published_at_utc": None, "newest_age_seconds": None, "matched_item_count": 0, "headlines": [], "error_class": "HTTP_429" if isinstance(exc, HTTPError) and exc.code == 429 else type(exc).__name__, "query": quoted_name if source == "google_news" else f'"{name}" sitewide'}
    matched: dict[str, dict] = {}
    undated_count = 0
    for item in items:
        where = _match(item, name, symbol)
        published = _timestamp(item.get("published"))
        link = item.get("url", "").strip()
        parsed_link = urlsplit(link)
        if parsed_link.scheme != "https" or not parsed_link.netloc:
            continue
        if where and link and not published:
            undated_count += 1
        if not where or not published or not link or published > now or (now - published).total_seconds() >= 604800:
            continue
        key = link or (item["title"], _iso(published))
        row = {"title": item["title"], "url": link, "published_at_utc": _iso(published), "age_seconds": max(0, int((now - published).total_seconds())), "matched_text": where}
        if key not in matched or row["age_seconds"] < matched[key]["age_seconds"]:
            matched[key] = row
    results = sorted(matched.values(), key=lambda row: row["published_at_utc"], reverse=True)
    return {"status": "FRESH", "query_at_utc": _iso(now), "relevant_count_24h": sum(row["age_seconds"] < 86400 for row in results), "relevant_count_7d": sum(row["age_seconds"] < 604800 for row in results), "newest_published_at_utc": results[0]["published_at_utc"] if results else None, "newest_age_seconds": results[0]["age_seconds"] if results else None, "matched_item_count": len(results), "undated_matched_item_count": undated_count, "headlines": results[:3], "error_class": None, "query": quoted_name if source == "google_news" else f'"{name}" sitewide'}


def _identity(coin_id: str, cached: dict | None, now: datetime) -> dict:
    cached = cached if isinstance(cached, dict) else {}
    if cached and _timestamp(cached.get("cached_at_utc")) and (now - _timestamp(cached["cached_at_utc"])).total_seconds() < 7 * 86400:
        platforms = cached.get("platforms") or {}
    else:
        url = f"https://api.coingecko.com/api/v3/coins/{quote(coin_id, safe='')}?localization=false&tickers=false&market_data=false&community_data=false&developer_data=false"
        detail = _json(url, "coingecko")
        platforms = detail.get("platforms") or {}
        cached.update({"cached_at_utc": _iso(now), "platforms": platforms})
    contracts = []
    for chain, address in platforms.items():
        if not isinstance(chain, str) or not isinstance(address, str) or not address.strip():
            continue
        explorer = _CHAIN_EXPLORERS.get(chain)
        contract = {"chain": chain, "address": address.strip(), "explorer_url": explorer[0] + quote(address.strip(), safe="") if explorer else None, "dex_url": f"https://dexscreener.com/{explorer[1]}/{quote(address.strip(), safe='')}" if explorer else None}
        contracts.append(contract)
    status = "MULTIPLE" if len(contracts) > 1 else "KNOWN" if len(contracts) == 1 else "UNKNOWN"
    return {"status": status, "contracts": contracts, "warning": "Multiple contract addresses; select a chain." if status == "MULTIPLE" else "Contract unavailable." if status == "UNKNOWN" else None}


def _dex(contract: dict, now: datetime) -> list[dict]:
    if not contract:
        return []
    chain = contract["chain"]
    address = contract["address"]
    url = f"https://api.dexscreener.com/token-pairs/v1/{quote(chain, safe='')}/{quote(address, safe='')}"
    try:
        body = _get(url, "application/json")
        rows = json.loads(body.decode("utf-8"))
        if not isinstance(rows, list):
            raise ValueError("invalid pair response")
    except Exception:
        return []
    pairs = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        created_ms = row.get("pairCreatedAt")
        try:
            created = datetime.fromtimestamp(float(created_ms) / 1000, timezone.utc) if created_ms is not None else None
        except (TypeError, ValueError, OSError, OverflowError):
            created = None
        tx = row.get("txns") or {}
        volume_by_period = row.get("volume") or {}
        liquidity_usd = (row.get("liquidity") or {}).get("usd")
        price_change = row.get("priceChange") or {}
        if liquidity_usd is None and created is None and not tx and not price_change and row.get("fdv") is None and row.get("marketCap") is None:
            volume_by_period = {period: None if value == 0 else value for period, value in volume_by_period.items()}
        pair_url = row.get("url")
        parsed_pair_url = urlsplit(pair_url or "")
        if parsed_pair_url.scheme != "https" or parsed_pair_url.hostname != "dexscreener.com":
            pair_url = None
        pairs.append({"chain": str(row.get("chainId") or chain), "coingecko_platform": chain, "token_address": address, "pair_address": row.get("pairAddress"), "pair_url": pair_url, "pair_created_at_utc": _iso(created) if created else None, "age_seconds": max(0, int((now - created).total_seconds())) if created else None, "liquidity_usd": liquidity_usd, "fdv_usd": row.get("fdv"), "market_cap_usd": row.get("marketCap"), "volume_by_period": volume_by_period, "buys_sells_by_period": tx, "price_change_by_period": price_change, "dex_id": row.get("dexId"), "captured_at_utc": _iso(now)})
    return sorted(pairs, key=lambda pair: (pair["liquidity_usd"] is not None, float(pair["liquidity_usd"] or 0)), reverse=True)


def _old_capture() -> dict | None:
    try:
        value = json.loads(V2_PATH.read_text(encoding="utf-8"))
        return value if validate_social_context(value) and value.get("status") in {"READY", "DEGRADED"} else None
    except (OSError, json.JSONDecodeError):
        return None


def validate_social_context(value: dict) -> bool:
    return isinstance(value, dict) and value.get("schema_version") == "social-context.v2" and value.get("research_only") is True and value.get("trade_authorization") is False and value.get("execution_allowed") is False and isinstance(value.get("items"), list) and isinstance(value.get("source_health"), dict)


def build_social_context(*, max_trending: int = MAX_TRENDING, enriched: int = MAX_ENRICHED, previous: dict | None = None, now: datetime | None = None) -> dict:
    """Production-default collector. Previous v2 state is read from the published artifact."""
    captured_at = now or _now()
    previous = previous if previous is not None else _old_capture()
    health = {}
    identity_cache = (previous or {}).get("identity_cache") or {}
    try:
        trending_response = _json("https://api.coingecko.com/api/v3/search/trending", "coingecko")
        trending = (trending_response.get("coins") or [])[:max_trending]
        health["coingecko_trending"] = {"status": "FRESH", "captured_at_utc": _iso(captured_at), "age_seconds": 0, "queried_count": 1, "response_count": len(trending), "error_class": None, "coverage_pct": 100.0}
    except Exception as exc:
        trending = []
        health["coingecko_trending"] = {"status": "FAILED", "captured_at_utc": _iso(captured_at), "age_seconds": 0, "queried_count": 1, "response_count": 0, "error_class": type(exc).__name__, "coverage_pct": 0.0}
    old_items = {item.get("coingecko_id"): item for item in (previous or {}).get("items", [])}
    items = []
    for rank, wrapper in enumerate(trending, 1):
        raw = wrapper.get("item") or {}
        coin_id = str(raw.get("id") or "")
        name = str(raw.get("name") or "")
        symbol = str(raw.get("symbol") or "").upper()
        if not coin_id or not name:
            continue
        data = raw.get("data") or {}
        market_cap = _number(data.get("market_cap_value", data.get("market_cap")))
        volume = _number(data.get("total_volume_value", data.get("total_volume")))
        change = (data.get("price_change_percentage_24h") or {}).get("usd")
        old = old_items.get(coin_id) or {}
        identity_cache.setdefault(coin_id, {})
        if rank <= enriched:
            try:
                identity = _identity(coin_id, identity_cache[coin_id], captured_at)
            except Exception as exc:
                identity = {"status": "UNKNOWN", "contracts": [], "warning": "Contract unavailable.", "error_class": type(exc).__name__}
        else:
            identity = old.get("identity") or {"status": "UNKNOWN", "contracts": [], "warning": "Contract lookup deferred by request budget."}
        if rank <= enriched:
            news = _mentions("google_news", name, symbol, captured_at)
            reddit = _mentions("reddit", name, symbol, captured_at)
        else:
            news = old.get("mentions", {}).get("google_news") or {"status": "NOT_QUERIED", "query_at_utc": None, "relevant_count_24h": None, "relevant_count_7d": None, "newest_published_at_utc": None, "newest_age_seconds": None, "matched_item_count": 0, "headlines": []}
            reddit = old.get("mentions", {}).get("reddit") or {"status": "NOT_QUERIED", "query_at_utc": None, "relevant_count_24h": None, "relevant_count_7d": None, "newest_published_at_utc": None, "newest_age_seconds": None, "matched_item_count": 0, "headlines": []}
        contracts = identity.get("contracts") or []
        dex_pairs = []
        for contract in contracts:
            dex_pairs.extend(_dex(contract, captured_at))
        dex_pairs.sort(key=lambda pair: (pair["liquidity_usd"] is not None, float(pair["liquidity_usd"] or 0)), reverse=True)
        primary_pair = next((pair for pair in dex_pairs if pair["liquidity_usd"] is not None), None)
        for pair in dex_pairs:
            pair["is_primary"] = pair is primary_pair
        rank_change = old.get("trending", {}).get("rank") - rank if old.get("trending", {}).get("rank") is not None else None
        old_volume = (old.get("market") or {}).get("volume_24h_usd")
        volume_change = round((volume / old_volume - 1) * 100, 6) if isinstance(volume, (int, float)) and isinstance(old_volume, (int, float)) and old_volume else None
        mention_changes = {}
        for source, current in (("google_news", news), ("reddit", reddit)):
            prior = (old.get("mentions", {}).get(source) or {})
            mention_changes[source] = {window: (current.get(f"relevant_count_{window}") - prior.get(f"relevant_count_{window}")) if isinstance(current.get(f"relevant_count_{window}"), int) and isinstance(prior.get(f"relevant_count_{window}"), int) else None for window in ("24h", "7d")}
        comparison = previous.get("captured_at_utc") if previous else None
        if not old:
            state = "NEW_SINCE_PRIOR_CAPTURE" if previous else "INSUFFICIENT_HISTORY"
        elif rank_change is None or volume_change is None or not comparison:
            state = "INSUFFICIENT_HISTORY"
        else:
            delta_mentions = sum(value for pair in mention_changes.values() for value in pair.values() if value is not None)
            state = "RISING" if rank_change > 0 or volume_change > 0 or delta_mentions > 0 else "FADING" if rank_change < 0 or volume_change < 0 or delta_mentions < 0 else "FLAT"
        market = {"price_usd": _number(data.get("price_value", data.get("price"))), "market_cap_usd": market_cap, "volume_24h_usd": volume, "volume_market_cap_ratio": volume / market_cap if isinstance(volume, (int, float)) and isinstance(market_cap, (int, float)) and market_cap else None, "change_24h_pct": change, "captured_at_utc": _iso(captured_at)}
        observations = []
        for pair in dex_pairs:
            liq = pair.get("liquidity_usd")
            denom = pair.get("fdv_usd") or pair.get("market_cap_usd") or market_cap
            vol24 = (pair.get("volume_by_period") or {}).get("h24")
            tx24 = (pair.get("buys_sells_by_period") or {}).get("h24") or {}
            buys, sells = tx24.get("buys"), tx24.get("sells")
            if pair.get("age_seconds") is not None and pair["age_seconds"] < 86400: observations.append({"kind": "PAIR_UNDER_24H", "source": "DEX Screener", "age_seconds": pair["age_seconds"], "pair_age_seconds": pair["age_seconds"]})
            if isinstance(liq, (int, float)) and isinstance(denom, (int, float)) and denom > 0 and liq / denom < .05: observations.append({"kind": "LIQUIDITY_UNDER_5_PERCENT", "source": "DEX Screener", "age_seconds": pair.get("age_seconds"), "liquidity_usd": liq, "fdv_or_market_cap_usd": denom, "ratio_pct": liq / denom * 100})
            if isinstance(buys, (int, float)) and isinstance(sells, (int, float)) and min(buys, sells) >= 0 and max(buys, sells) >= 20 and max(buys, sells) >= 1.5 * max(1, min(buys, sells)): observations.append({"kind": "BUY_SELL_IMBALANCE", "source": "DEX Screener 24h transactions", "age_seconds": pair.get("age_seconds"), "buys_24h": buys, "sells_24h": sells})
        if isinstance(volume, (int, float)) and isinstance(market_cap, (int, float)) and volume > market_cap: observations.append({"kind": "VOLUME_ABOVE_MARKET_CAP", "source": "CoinGecko 24h volume and market cap", "age_seconds": 0, "volume_24h_usd": volume, "market_cap_usd": market_cap})
        if isinstance(change, (int, float)) and change > 100: observations.append({"kind": "PRICE_MOVE_ABOVE_100_PERCENT", "source": "CoinGecko rolling 24h trending snapshot", "age_seconds": 0, "change_24h_pct": change})
        items.append({"coingecko_id": coin_id, "name": name, "symbol": symbol, "observed_at_utc": _iso(captured_at), "trending": {"rank": rank, "previous_rank": old.get("trending", {}).get("rank"), "change": rank_change, "state": state, "window": "rolling 24h"}, "market": market, "identity": identity, "mentions": {"google_news": news, "reddit": reddit}, "dex_pairs": dex_pairs, "momentum": {"rank_change": rank_change, "volume_change_pct": volume_change, "mention_change_by_source": mention_changes, "comparison_at_utc": comparison, "state": state}, "fomo_watch": {"status": "WATCH_ONLY" if observations else "NO_OBSERVATION" if dex_pairs else "UNKNOWN", "observations": observations, "disclaimer": "Descriptive observations only; no score, direction, or trade gate."}})
    for source in ("google_news", "reddit"):
        vals = [item["mentions"][source] for item in items if item["mentions"][source]["status"] != "NOT_QUERIED"]
        failed = sum(value["status"] != "FRESH" for value in vals)
        status = "FAILED" if vals and failed == len(vals) else "DEGRADED" if failed else "FRESH" if vals else "NOT_QUERIED"
        health[source] = {"status": status, "captured_at_utc": _iso(captured_at), "age_seconds": 0, "queried_count": len(vals), "response_count": len(vals) - failed, "error_class": "SOURCE_FAILURE" if failed else None, "coverage_pct": (len(vals) - failed) / len(vals) * 100 if vals else None}
    health["coingecko_identity"] = {"status": "FRESH" if identity_cache else "NOT_QUERIED", "captured_at_utc": _iso(captured_at), "age_seconds": 0, "queried_count": min(enriched, len(trending)), "response_count": sum(bool((item.get("identity") or {}).get("contracts")) for item in items), "error_class": None, "coverage_pct": None}
    health["dex_screener"] = {"status": "FRESH" if any(item["dex_pairs"] for item in items) else "DEGRADED", "captured_at_utc": _iso(captured_at), "age_seconds": 0, "queried_count": sum(bool(item["identity"].get("contracts")) for item in items), "response_count": sum(bool(item["dex_pairs"]) for item in items), "error_class": None, "coverage_pct": None}
    statuses = [value["status"] for value in health.values()]
    result = {"schema_version": "social-context.v2", "status": "NO_DATA" if not items else "DEGRADED" if any(status in {"FAILED", "DEGRADED"} for status in statuses) else "READY", "captured_at_utc": _iso(captured_at), "previous_capture_at_utc": previous.get("captured_at_utc") if previous else None, "research_only": True, "trade_authorization": False, "execution_allowed": False, "source_health": health, "items": items, "identity_cache": identity_cache, "attribution": "Trending and token identity data provided by CoinGecko."}
    if not validate_social_context(result):
        raise ValueError("collector emitted invalid social-context.v2")
    return result


def write_social_context(value: dict, path: Path = V2_PATH) -> None:
    if not validate_social_context(value):
        raise ValueError("refusing to write invalid social-context.v2")
    path.write_text(json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n", encoding="utf-8")
