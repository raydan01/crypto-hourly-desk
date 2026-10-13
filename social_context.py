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
CG_MIN_INTERVAL = 15.0
REDDIT_MIN_INTERVAL = 2.0
_last_cg_call = 0.0
_last_reddit_call = 0.0
_CHAIN_MAP = {
    "solana": ("solana", "https://solscan.io/account/"),
    "ethereum": ("ethereum", "https://etherscan.io/address/"),
    "binance-smart-chain": ("bsc", "https://bscscan.com/address/"),
    "polygon-pos": ("polygon", "https://polygonscan.com/address/"),
    "arbitrum-one": ("arbitrum", "https://arbiscan.io/address/"),
    "optimistic-ethereum": ("optimism", "https://optimistic.etherscan.io/address/"),
    "base": ("base", "https://basescan.org/address/"),
    "robinhood": ("robinhood", "https://robinhoodchain.blockscout.com/address/"),
}
_last_response_headers = {}
_reddit_stopped = False
_cg_identity_stopped = False
_cg_identity_deadline = None


class RedditUnavailable(RuntimeError):
    pass


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _http_get(url: str, accept: str = "application/json") -> tuple[int, bytes]:
    global _last_response_headers
    request = Request(url, headers={"Accept": accept, "User-Agent": UA})
    try:
        with urlopen(request, timeout=20) as response:
            _last_response_headers = {key.lower(): value for key, value in response.headers.items()}
            return int(response.status), response.read()
    except HTTPError as exc:
        _last_response_headers = {key.lower(): value for key, value in (exc.headers.items() if exc.headers else [])}
        return int(exc.code), exc.read()


def _pace(provider: str) -> None:
    global _last_cg_call, _last_reddit_call
    if provider in {"coingecko", "coingecko_identity"}:
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
    global _reddit_stopped
    if provider == "reddit" and _reddit_stopped:
        raise RedditUnavailable("rate-limited by Reddit")
    last_error = None
    attempts = 1 if provider in {"reddit", "coingecko_identity"} else len(RETRY_DELAYS_SECONDS) + 1
    for attempt in range(attempts):
        if provider:
            _pace(provider)
        try:
            status, body = _http_get(url, accept)
            remaining = _last_response_headers.get("x-ratelimit-remaining")
            rate_empty = remaining is not None and _number(remaining) == 0
            if provider == "reddit" and (status == 429 or rate_empty):
                _reddit_stopped = True
                raise RedditUnavailable("rate-limited by Reddit")
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


_LISTING_SOURCES = {"coingecko", "coinmarketcap", "cryptorank", "coincodex", "coinstats", "coinlore", "binance", "crypto.com", "coinbase", "kraken", "mexc", "bitget", "kucoin", "gate.io", "lbank"}
_LISTING_WORDING = ("Price Today", "Live Price", "Price Chart", "Converter", "Exchange Rate", "Markets", "Buy & Sell", "Analytics", "Market Cap", "/USD")


def _is_listing_page(item: dict, name: str = "", symbol: str = "") -> bool:
    """Identify price-tracker and exchange listings from the title's source suffix."""
    title = str(item.get("title") or "")
    if " - " not in title:
        return False
    source = title.rsplit(" - ", 1)[1].strip().casefold()
    same_name_symbol = bool(symbol and name.casefold() == symbol.casefold())
    dollar_symbol = bool(symbol and re.search(r"(?<![\w])\$" + re.escape(symbol) + r"(?![\w])", title))
    parenthesized_symbol = bool(symbol and re.search(r"\(\s*" + re.escape(symbol) + r"\s*\)", title))
    if same_name_symbol and source == "cryptorank" and not (dollar_symbol or parenthesized_symbol):
        return False
    return source in _LISTING_SOURCES and any(phrase.casefold() in title.casefold() for phrase in _LISTING_WORDING)


def _mention_tier(item: dict, name: str, symbol: str) -> str | None:
    """Classify a title as about this coin, related crypto buzz, or unrelated."""
    title = str(item.get("title") or "")
    if _is_listing_page(item, name, symbol):
        return None
    symbol = symbol.strip().upper()
    name_match = _contains(title, name)
    # A few common names double as their entire ticker (the recorded CLAUDIA
    # feed includes human headlines and CryptoRank converter pages). Treating
    # that exact spelling as an independent symbol would turn those into coin
    # matches. Other explicit ticker forms remain unambiguous.
    same_name_symbol = bool(symbol and name.casefold() == symbol.casefold())
    dollar_symbol = bool(symbol and re.search(r"(?<![\w])\$" + re.escape(symbol) + r"(?![\w])", title))
    parenthesized_symbol = bool(symbol and re.search(r"\(\s*" + re.escape(symbol) + r"\s*\)", title))
    if same_name_symbol and "cryptorank" in title.casefold() and not (dollar_symbol or parenthesized_symbol):
        return None
    uppercase_symbol = bool(symbol and not same_name_symbol and re.search(r"(?<![\w])" + re.escape(symbol) + r"(?![\w])", title))
    asset_match = name_match or dollar_symbol or parenthesized_symbol or uppercase_symbol
    if not asset_match:
        return None

    name_followed_by_coin_marker = bool(name_match and re.search(
        re.escape(name) + r"(?:\W+\w+){0,3}\W+(?:token|coin|memecoin|meme\s+coin|price|presale)(?!\w)",
        title, re.IGNORECASE,
    ))
    usd_price_with_word_price = bool(name_match and re.search(r"\$\d+(?:\.\d+)?", title) and _contains(title, "price"))
    if dollar_symbol or parenthesized_symbol or uppercase_symbol or name_followed_by_coin_marker or usd_price_with_word_price:
        return "coin"

    # The broader title relevance rule is retained as a secondary signal. It
    # requires the actual name; context text in the description is ignored.
    context_terms = ("crypto", "cryptocurrency", "token", "coin", "memecoin", "meme coin", "blockchain", "defi", "dex", "airdrop", "presale", "solana", "ethereum", "bnb chain", "robinhood chain", "pump.fun", "coingecko", "coinmarketcap")
    if name_match and any(_contains(title, term) for term in context_terms):
        return "related"
    return None


def _match(item: dict, name: str, symbol: str) -> str | None:
    """Compatibility helper returning the legacy title match marker."""
    return "title" if _mention_tier(item, name, symbol) else None


def _mentions(source: str, name: str, symbol: str, now: datetime) -> dict:
    quoted_name = f'"{name}" (crypto OR token OR coin OR "{symbol}") when:7d' if source == "google_news" else f'"{name}"'
    if source == "google_news":
        url = "https://news.google.com/rss/search?q=" + quote_plus(quoted_name) + "&hl=en-US&gl=US&ceid=US:en"
        accept = "application/rss+xml, application/atom+xml"
        provider = None
    else:
        url = "https://www.reddit.com/search.rss?q=" + quote_plus(f'"{name}"') + "&sort=new"
        accept = "application/rss+xml, application/atom+xml"
        provider = "reddit"
    try:
        items = _rss_items(_get(url, accept, provider))
    except Exception as exc:
        limited = source == "reddit" and isinstance(exc, RedditUnavailable)
        quota = {name: _last_response_headers[name] for name in ("x-ratelimit-used", "x-ratelimit-remaining", "x-ratelimit-reset") if name in _last_response_headers} if limited else None
        return {"status": "UNAVAILABLE" if limited else "DEGRADED", "reason": "rate-limited by Reddit" if limited else None, "rate_limit_headers": quota, "query_at_utc": _iso(now), "coin_count_24h": None, "coin_count_7d": None, "related_count_24h": None, "related_count_7d": None, "listing_count_7d": None, "newest_published_at_utc": None, "newest_age_seconds": None, "matched_item_count": 0, "related_item_count": 0, "headlines": [], "related_headlines": [], "error_class": "HTTP_429" if limited else type(exc).__name__, "query": quoted_name if source == "google_news" else f'"{name}" sitewide'}
    matched: dict[str, dict[str, dict]] = {"coin": {}, "related": {}}
    listing_rows: dict[str, int] = {}
    undated_count = 0
    for item in items:
        tier = _mention_tier(item, name, symbol)
        published = _timestamp(item.get("published"))
        link = item.get("url", "").strip()
        parsed_link = urlsplit(link)
        if parsed_link.scheme != "https" or not parsed_link.netloc:
            continue
        if _is_listing_page(item, name, symbol):
            if published and published <= now and (now - published).total_seconds() < 604800:
                age = max(0, int((now - published).total_seconds()))
                if link not in listing_rows or age < listing_rows[link]:
                    listing_rows[link] = age
            continue
        if tier and link and not published:
            undated_count += 1
        if not tier or not published or not link or published > now or (now - published).total_seconds() >= 604800:
            continue
        key = link or (item["title"], _iso(published))
        if tier == "related" and key in matched["coin"]:
            continue
        if tier == "coin":
            matched["related"].pop(key, None)
        rows = matched[tier]
        row = {"title": item["title"], "url": link, "published_at_utc": _iso(published), "age_seconds": max(0, int((now - published).total_seconds())), "matched_text": tier}
        if key not in rows or row["age_seconds"] < rows[key]["age_seconds"]:
            rows[key] = row
    coin_rows = sorted(matched["coin"].values(), key=lambda row: row["published_at_utc"], reverse=True)
    related_rows = sorted(matched["related"].values(), key=lambda row: row["published_at_utc"], reverse=True)
    return {"status": "FRESH", "query_at_utc": _iso(now), "coin_count_24h": sum(row["age_seconds"] < 86400 for row in coin_rows), "coin_count_7d": sum(row["age_seconds"] < 604800 for row in coin_rows), "related_count_24h": sum(row["age_seconds"] < 86400 for row in related_rows), "related_count_7d": sum(row["age_seconds"] < 604800 for row in related_rows), "listing_count_7d": len(listing_rows), "newest_published_at_utc": coin_rows[0]["published_at_utc"] if coin_rows else None, "newest_age_seconds": coin_rows[0]["age_seconds"] if coin_rows else None, "matched_item_count": len(coin_rows), "related_item_count": len(related_rows), "undated_matched_item_count": undated_count, "headlines": coin_rows[:3], "related_headlines": related_rows[:3], "error_class": None, "query": quoted_name if source == "google_news" else f'"{name}" sitewide'}


def _identity(coin_id: str, cached: dict | None, now: datetime) -> dict:
    cached = cached if isinstance(cached, dict) else {}
    cache_time = _timestamp(cached.get("cached_at_utc")) if cached else None
    cache_age = (now - cache_time).total_seconds() if cache_time else None
    if cached and cache_time and 0 <= cache_age <= 7 * 86400:
        platforms = cached.get("platforms") or {}
        identity_source = "CACHE"
    else:
        url = f"https://api.coingecko.com/api/v3/coins/{quote(coin_id, safe='')}?localization=false&tickers=false&market_data=false&community_data=false&developer_data=false"
        detail = _identity_json(url)
        platforms = detail.get("platforms") or {}
        cached.update({"cached_at_utc": _iso(now), "platforms": platforms})
        identity_source = "FRESH"
        cache_age = 0
    contracts = []
    malformed_chains = []
    for chain, address in platforms.items():
        if not isinstance(chain, str) or not isinstance(address, str) or not address.strip():
            continue
        address = address.strip()
        valid = bool(re.fullmatch(r"[1-9A-HJ-NP-Za-km-z]{32,44}", address)) if chain == "solana" else bool(re.fullmatch(r"0x[0-9a-fA-F]{40}", address))
        if not valid:
            malformed_chains.append(chain)
            contracts.append({"chain": chain, "address": address, "status": "MALFORMED", "dex_chain": None, "explorer_url": None, "dex_url": None, "dex_status": "MALFORMED"})
            continue
        mapped = _CHAIN_MAP.get(chain)
        dex_chain = mapped[0] if mapped else None
        explorer_base = mapped[1] if mapped else None
        contract = {"chain": chain, "dex_chain": dex_chain, "address": address, "explorer_url": explorer_base + quote(address, safe="") if explorer_base else None, "dex_url": f"https://dexscreener.com/{dex_chain}/{quote(address, safe='')}" if dex_chain else None, "dex_status": "NOT_QUERIED" if dex_chain else "UNSUPPORTED"}
        contracts.append(contract)
    valid_count = sum(contract.get("status") != "MALFORMED" for contract in contracts)
    status = "MULTIPLE" if valid_count > 1 else "KNOWN" if valid_count == 1 else "MALFORMED" if malformed_chains else "UNKNOWN"
    unsupported = any(contract.get("dex_status") == "UNSUPPORTED" for contract in contracts)
    warning_parts = []
    if malformed_chains:
        warning_parts.append("Malformed contract address for " + ", ".join(malformed_chains) + "; links and DEX lookup disabled.")
    if unsupported:
        warning_parts.append("DEX lookup not supported for this chain.")
    if not warning_parts and status == "MULTIPLE":
        warning_parts.append("Multiple contract addresses; select a chain.")
    if not warning_parts and status == "UNKNOWN":
        warning_parts.append("Contract unavailable.")
    warning = " ".join(warning_parts) or None
    warning_parts.append((f"Contract data from cache, {_age_label(cache_age)}.") if identity_source == "CACHE" else "")
    return {"status": status, "contracts": contracts, "warning": " ".join(part for part in warning_parts if part) or None, "source": identity_source, "cached_age_seconds": cache_age if identity_source == "CACHE" else None}


def _age_label(seconds: float | None) -> str:
    seconds = max(0, int(seconds or 0))
    if seconds < 3600:
        return f"{seconds // 60} minutes"
    if seconds < 86400:
        return f"{seconds // 3600} hours"
    return f"{seconds // 86400} days"


def _identity_json(url: str) -> dict:
    """Fetch an identity, honouring CoinGecko Retry-After once for 429s."""
    global _cg_identity_stopped
    if _cg_identity_stopped:
        raise HTTPError(url, 429, "identity lookups stopped after rate limit", None, None)
    if _cg_identity_deadline is not None and _cg_identity_deadline - time.monotonic() < 20:
        raise TimeoutError("identity lookup budget exhausted")
    try:
        return _json(url, "coingecko_identity")
    except HTTPError as exc:
        if exc.code != 429:
            raise
        retry_after = _timestamp(_last_response_headers.get("retry-after"))
        if retry_after:
            wait = min(60, max(0, (retry_after - _now()).total_seconds()))
        else:
            try:
                wait = min(60, max(0, float(_last_response_headers.get("retry-after", 0) or 0)))
            except (TypeError, ValueError):
                wait = 0
        if wait:
            time.sleep(wait)
        if _cg_identity_deadline is not None and _cg_identity_deadline - time.monotonic() < 20:
            _cg_identity_stopped = True
            raise exc
        try:
            return _json(url, "coingecko_identity")
        except HTTPError as second:
            if second.code == 429:
                _cg_identity_stopped = True
                raise
            raise


def _dex(contract: dict, now: datetime) -> list[dict]:
    if not contract:
        return []
    if contract.get("status") == "MALFORMED":
        return []
    chain = contract.get("dex_chain")
    if not chain:
        contract["dex_status"] = "UNSUPPORTED"
        return []
    address = contract["address"]
    url = f"https://api.dexscreener.com/token-pairs/v1/{quote(chain, safe='')}/{quote(address, safe='')}"
    try:
        body = _get(url, "application/json")
        rows = json.loads(body.decode("utf-8"))
        if not isinstance(rows, list):
            raise ValueError("invalid pair response")
    except Exception as exc:
        contract["dex_status"] = "FAILED"
        contract["dex_error_class"] = type(exc).__name__
        return []
    contract["dex_status"] = "FRESH"
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
        pairs.append({"chain": str(row.get("chainId") or chain), "coingecko_platform": contract["chain"], "token_address": address, "pair_address": row.get("pairAddress"), "pair_url": pair_url, "pair_created_at_utc": _iso(created) if created else None, "age_seconds": max(0, int((now - created).total_seconds())) if created else None, "liquidity_usd": liquidity_usd, "fdv_usd": row.get("fdv"), "market_cap_usd": row.get("marketCap"), "volume_by_period": volume_by_period, "buys_sells_by_period": tx, "price_change_by_period": price_change, "dex_id": row.get("dexId"), "captured_at_utc": _iso(now)})
    return sorted(pairs, key=lambda pair: (pair["liquidity_usd"] is not None, float(pair["liquidity_usd"] or 0)), reverse=True)


def _old_capture() -> dict | None:
    try:
        value = json.loads(V2_PATH.read_text(encoding="utf-8"))
        return value if validate_social_context(value) and value.get("status") in {"READY", "DEGRADED"} else None
    except (OSError, json.JSONDecodeError):
        return None


def validate_social_context(value: dict) -> bool:
    if not (isinstance(value, dict) and value.get("schema_version") == "social-context.v2" and value.get("research_only") is True and value.get("trade_authorization") is False and value.get("execution_allowed") is False and isinstance(value.get("items"), list) and isinstance(value.get("source_health"), dict)):
        return False
    required = {"coin_count_24h", "coin_count_7d", "related_count_24h", "related_count_7d", "listing_count_7d", "headlines", "related_headlines"}
    for item in value["items"]:
        mentions = item.get("mentions") if isinstance(item, dict) else None
        if not isinstance(mentions, dict):
            return False
        for source in ("google_news", "reddit"):
            mention = mentions.get(source)
            if not isinstance(mention, dict) or not required.issubset(mention):
                return False
            if any(not isinstance(mention[field], list) or len(mention[field]) > 3 for field in ("headlines", "related_headlines")):
                return False
            for field in ("coin_count_24h", "coin_count_7d", "related_count_24h", "related_count_7d", "listing_count_7d"):
                count = mention[field]
                if mention.get("status") == "FRESH":
                    if not isinstance(count, int) or isinstance(count, bool) or count < 0:
                        return False
                elif count is not None:
                    return False
    return True


def build_social_context(*, max_trending: int = MAX_TRENDING, enriched: int = MAX_ENRICHED, previous: dict | None = None, now: datetime | None = None) -> dict:
    """Production-default collector. Previous v2 state is read from the published artifact."""
    captured_at = now or _now()
    previous = previous if previous is not None else _old_capture()
    global _reddit_stopped
    _reddit_stopped = False
    global _cg_identity_stopped
    _cg_identity_stopped = False
    global _cg_identity_deadline
    _cg_identity_deadline = time.monotonic() + 330
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
                status = getattr(exc, "code", None)
                identity = {"status": "LOOKUP_FAILED", "contracts": [], "warning": "Contract lookup failed this capture (CoinGecko limit). Retry next hour", "error_class": type(exc).__name__, "http_status": status}
        else:
            identity = old.get("identity") or {"status": "UNKNOWN", "contracts": [], "warning": "Contract lookup deferred by request budget."}
        if rank <= enriched:
            news = _mentions("google_news", name, symbol, captured_at)
            reddit = _mentions("reddit", name, symbol, captured_at)
        else:
            news = {"status": "NOT_QUERIED", "query_at_utc": None, "coin_count_24h": None, "coin_count_7d": None, "related_count_24h": None, "related_count_7d": None, "listing_count_7d": None, "newest_published_at_utc": None, "newest_age_seconds": None, "matched_item_count": 0, "related_item_count": 0, "headlines": [], "related_headlines": []}
            reddit = dict(news)
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
            mention_changes[source] = {window: (current.get(f"coin_count_{window}") - prior.get(f"coin_count_{window}")) if current.get("status") == "FRESH" and prior.get("status") == "FRESH" and isinstance(current.get(f"coin_count_{window}"), int) and isinstance(prior.get(f"coin_count_{window}"), int) else None for window in ("24h", "7d")}
        prior_time = _timestamp(previous.get("captured_at_utc")) if previous else None
        comparable = bool(prior_time and prior_time < captured_at and old and isinstance(old.get("trending", {}).get("rank"), int) and isinstance(old_volume, (int, float)) and old_volume > 0 and isinstance(volume, (int, float)))
        comparison = _iso(prior_time) if comparable else None
        if not comparable:
            rank_change = None
            volume_change = None
            mention_changes = {source: {window: None for window in ("24h", "7d")} for source in ("google_news", "reddit")}
        if not old:
            state = "NEW_SINCE_PRIOR_CAPTURE" if previous else "INSUFFICIENT_HISTORY"
        elif not comparable or rank_change is None or volume_change is None:
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
        items.append({"coingecko_id": coin_id, "name": name, "symbol": symbol, "observed_at_utc": _iso(captured_at), "trending": {"rank": rank, "previous_rank": old.get("trending", {}).get("rank") if comparable else None, "change": rank_change, "state": state, "window": "rolling 24h"}, "market": market, "identity": identity, "mentions": {"google_news": news, "reddit": reddit}, "dex_pairs": dex_pairs, "momentum": {"rank_change": rank_change, "volume_change_pct": volume_change, "mention_change_by_source": mention_changes, "comparison_at_utc": comparison, "state": state}, "fomo_watch": {"status": "WATCH_ONLY" if observations else "NO_OBSERVATION" if dex_pairs else "UNKNOWN", "observations": observations, "disclaimer": "Descriptive observations only; no score, direction, or trade gate."}})
    for source in ("google_news", "reddit"):
        vals = [item["mentions"][source] for item in items if item["mentions"][source]["status"] != "NOT_QUERIED"]
        failed = sum(value["status"] != "FRESH" for value in vals)
        status = "FAILED" if vals and failed == len(vals) else "DEGRADED" if failed else "FRESH" if vals else "NOT_QUERIED"
        rate_limited = source == "reddit" and any(value.get("error_class") in {"RATE_LIMITED", "HTTP_429"} for value in vals)
        health[source] = {"status": status, "captured_at_utc": _iso(captured_at), "age_seconds": 0, "queried_count": len(vals), "response_count": len(vals) - failed, "error_class": "RATE_LIMITED" if rate_limited else "SOURCE_FAILURE" if failed else None, "coverage_pct": (len(vals) - failed) / len(vals) * 100 if vals else None}
    identity_errors = sum(item["identity"].get("status") == "LOOKUP_FAILED" for item in items)
    identity_queried = min(enriched, len(items))
    identity_cache_hits = sum((item.get("identity") or {}).get("source") == "CACHE" for item in items)
    identity_fresh = sum((item.get("identity") or {}).get("source") == "FRESH" for item in items)
    health["coingecko_identity"] = {"status": "DEGRADED" if identity_errors else "FRESH" if identity_queried else "NOT_QUERIED", "captured_at_utc": _iso(captured_at), "age_seconds": 0, "queried_count": identity_queried, "fresh_fetch_count": identity_fresh, "cache_hit_count": identity_cache_hits, "response_count": identity_fresh + identity_cache_hits, "error_class": "identity_fetch_failed" if identity_errors else None, "coverage_pct": 100.0 * (identity_queried - identity_errors) / identity_queried if identity_queried else None}
    dex_contracts = [contract for item in items for contract in (item.get("identity") or {}).get("contracts", []) if contract.get("dex_chain")]
    dex_failed = sum(contract.get("dex_status") == "FAILED" for contract in dex_contracts)
    dex_success = sum(contract.get("dex_status") == "FRESH" for contract in dex_contracts)
    health["dex_screener"] = {"status": "DEGRADED" if dex_failed else "FRESH" if dex_success else "NOT_QUERIED", "captured_at_utc": _iso(captured_at), "age_seconds": 0, "queried_count": len(dex_contracts), "response_count": dex_success, "error_class": "dex_lookup_failed" if dex_failed else None, "coverage_pct": 100.0 * dex_success / len(dex_contracts) if dex_contracts else None}
    statuses = [value["status"] for value in health.values()]
    result = {"schema_version": "social-context.v2", "status": "NO_DATA" if not items else "DEGRADED" if any(status in {"FAILED", "DEGRADED"} for status in statuses) else "READY", "captured_at_utc": _iso(captured_at), "previous_capture_at_utc": previous.get("captured_at_utc") if previous else None, "research_only": True, "trade_authorization": False, "execution_allowed": False, "source_health": health, "items": items, "identity_cache": identity_cache, "attribution": "Trending and token identity data provided by CoinGecko."}
    if not validate_social_context(result):
        raise ValueError("collector emitted invalid social-context.v2")
    _cg_identity_deadline = None
    return result


def write_social_context(value: dict, path: Path = V2_PATH) -> None:
    if not validate_social_context(value):
        raise ValueError("refusing to write invalid social-context.v2")
    path.write_text(json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n", encoding="utf-8")
