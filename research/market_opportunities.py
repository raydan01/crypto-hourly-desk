"""Pure helpers for the read-only Market Opportunities experience."""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
import math
from statistics import pstdev
from typing import Any, Mapping, Sequence


@dataclass(frozen=True)
class OpportunityConfig:
    long_change_pct: float = 1.0
    short_change_pct: float = -1.0
    max_results: int = 20
    max_avoid_results: int = 20


def _clamp(value: float, low: float = -1.0, high: float = 1.0) -> float:
    return max(low, min(high, value))


def score_candidate(item: Mapping[str, Any], social_item: Mapping[str, Any] | None = None) -> dict[str, Any]:
    """Combine market tradability and social/news context into a ranked score.

    This is a deterministic confidence score, not a calibrated probability.
    Social direction uses the current CoinGecko-trending 24h move when present;
    news and Reddit counts add attention/confidence but do not imply sentiment.
    """
    metrics = item.get("metrics") or {}
    change = float(metrics.get("change_24h_pct") or 0.0)
    spread = max(0.0, float(metrics.get("spread_bps") or 0.0))
    volume = max(0.0, float(metrics.get("volume_24h_quote") or 0.0))
    volatility = max(0.0, float(metrics.get("volatility_24h") or 0.0))
    market_direction = _clamp(change / 5.0)
    directional_strength = min(abs(change) / 5.0, 1.0) * 100.0
    liquidity_score = min(100.0, (volume / 10000000.0) ** 0.5 * 100.0) if volume else 0.0
    spread_score = max(0.0, 100.0 - spread * 10.0)
    volatility_score = max(0.0, 100.0 - abs(volatility - 0.04) * 1200.0)
    market_score = round(directional_strength * 0.45 + liquidity_score * 0.25 + spread_score * 0.15 + volatility_score * 0.15, 2)
    social = social_item or {}
    attention = max(0.0, min(100.0, float(social.get("attention_score") or 0.0)))
    counts = social.get("source_counts") or {}
    source_bonus = min(20.0, float(counts.get("google_news") or 0) * 0.5 + float(counts.get("reddit") or 0) * 1.0)
    social_score = round(min(100.0, attention * 0.8 + source_bonus), 2)
    social_change = social.get("price_change_24h_pct")
    social_direction = _clamp(float(social_change) / 5.0) if social_change is not None else 0.0
    combined_direction = round(market_direction * 0.70 + social_direction * 0.30, 4)
    score = round(market_score * 0.70 + social_score * 0.30, 2)
    if combined_direction >= 0.25:
        bias = "LONG_RESEARCH"
    elif combined_direction <= -0.25:
        bias = "SHORT_RESEARCH"
    else:
        bias = "AVOID"
    band = "HIGH" if score >= 70 else ("MODERATE" if score >= 45 else "LOW")
    return {"score": score, "band": band, "bias": bias, "market_score": market_score, "social_score": social_score, "market_direction": round(market_direction, 4), "social_direction": round(social_direction, 4), "combined_direction": combined_direction, "social_sources": list(social.get("sources") or [])}


def _utc(value: str) -> datetime:
    text = value.strip().replace("Z", "+00:00")
    parsed = datetime.fromisoformat(text)
    if parsed.tzinfo is None:
        raise ValueError("timestamp must include a UTC offset")
    return parsed.astimezone(timezone.utc)


def classify_bias(change_24h_pct: Any, margin_status: str, config: OpportunityConfig | None = None) -> str:
    """Return a research label; never returns an execution instruction."""
    active = config or OpportunityConfig()
    try:
        change = float(change_24h_pct)
    except (TypeError, ValueError):
        return "AVOID"
    if not math.isfinite(change):
        return "AVOID"
    if change >= active.long_change_pct:
        return "LONG_RESEARCH"
    if change <= active.short_change_pct:
        return "SHORT_RESEARCH"
    return "AVOID"


def realized_volatility(closes: Sequence[float]) -> float | None:
    if len(closes) < 3 or any(not math.isfinite(float(value)) or float(value) <= 0 for value in closes):
        return None
    returns = [math.log(float(current) / float(previous)) for previous, current in zip(closes, closes[1:])]
    return pstdev(returns) if returns else None


def build_price_map(item: Mapping[str, Any]) -> dict[str, Any] | None:
    """Build a deterministic range-based planning map for directional research."""
    metrics = item.get("metrics") or {}
    try:
        last = float(metrics["last"])
        high = float(metrics.get("high_24h", last))
        low = float(metrics.get("low_24h", last))
    except (KeyError, TypeError, ValueError):
        return None
    if not all(math.isfinite(value) and value > 0 for value in (last, high, low)) or high < low:
        return None
    range_size = max(high - low, last * 0.005)
    bias = str(item.get("bias") or "")
    if bias == "LONG_RESEARCH":
        return {
            "side": "LONG_RESEARCH",
            "entry_low": round(max(low, last - range_size * 0.35), 10),
            "entry_high": round(last, 10),
            "invalidation": round(max(0.0, low - range_size * 0.25), 10),
            "target_one": round(last + range_size * 0.50, 10),
            "target_two": round(last + range_size, 10),
            "method": "24-hour range pullback and extension map",
        }
    if bias == "SHORT_RESEARCH":
        return {
            "side": "SHORT_RESEARCH",
            "entry_low": round(last, 10),
            "entry_high": round(last + range_size * 0.35, 10),
            "invalidation": round(high + range_size * 0.25, 10),
            "target_one": round(last - range_size * 0.50, 10),
            "target_two": round(max(0.0, last - range_size), 10),
            "method": "24-hour range rejection and extension map",
        }
    return None


def build_opportunity_payload(
    scan: Mapping[str, Any],
    *,
    generated_at_utc: str,
    cadence: str,
    social_context: Mapping[str, Any] | None = None,
    config: OpportunityConfig | None = None,
) -> dict[str, Any]:
    """Decorate scanner candidates for the UI with bounded research labels."""
    active = config or OpportunityConfig()
    generated = _utc(generated_at_utc)
    social_by_symbol = {str(row.get("symbol") or "").upper(): row for row in (social_context or {}).get("items", []) if row.get("symbol")}
    candidates = []
    for item in list(scan.get("candidates") or [])[: active.max_results]:
        metrics = dict(item.get("metrics") or {})
        change = metrics.get("change_24h_pct")
        margin_status = str(item.get("margin_status") or "unknown")
        ranking = score_candidate(item, social_by_symbol.get(str(item.get("symbol") or "").upper()))
        bias = ranking["bias"]
        if bias == "SHORT_RESEARCH" and margin_status != "verified_enabled":
            quick_reason = "Quality filters passed and bearish movement cleared the research threshold. SHORT research is visible, but margin permission is not verified; no short execution is allowed."
        elif bias != "AVOID":
            quick_reason = "Quality filters passed; directional movement cleared the research threshold."
        else:
            quick_reason = "Quality filters passed, but directional movement did not clear the research threshold."
        candidates.append({
            **item,
            "bias": bias,
            "opportunity_score": ranking["score"],
            "confidence_band": ranking["band"],
            "score_breakdown": ranking,
            "timeframe": "SHORT_TERM" if cadence == "hourly" else "MEDIUM_LONG_TERM",
            "research_only": True,
            "trade_authorization": False,
            "execution_allowed": False,
            "explanation": {
                "directional_change_24h_pct": change,
                "market_quality": "passed liquidity, spread, volatility, and freshness filters",
                "margin_note": "Margin status is informational and venue-controlled.",
                "quick_reason": quick_reason,
            },
        })
        candidates[-1]["price_map"] = build_price_map(candidates[-1])
    candidates.sort(key=lambda row: (-float(row.get("opportunity_score", 0)), str(row.get("symbol", ""))))
    opportunities = [item for item in candidates if item.get("bias") != "AVOID"]
    neutral_candidates = [item for item in candidates if item.get("bias") == "AVOID"]
    rejection_priority = {
        "VOLATILITY_OUT_OF_RANGE": 1,
        "SPREAD_TOO_WIDE": 2,
        "INSUFFICIENT_LIQUIDITY": 3,
        "STALE_SNAPSHOT": 4,
        "INVALID_PRICE_OR_TIME_RANGE": 5,
    }
    rejected = []
    for item in list(scan.get("rejections") or []):
        symbol = str(item.get("symbol") or "").upper()
        if not symbol:
            continue
        reason = str(item.get("reason") or "DATA_QUALITY_FAILURE")
        rejected.append({
            "symbol": symbol,
            "rank_score": 0,
            "rank": len(rejected) + 1,
            "bias": "AVOID",
            "timeframe": "SHORT_TERM" if cadence == "hourly" else "MEDIUM_LONG_TERM",
            "metrics": dict(item.get("metrics") or {}),
            "avoid_reason": reason,
            "explanation": {"market_quality": "failed one or more scan safeguards", "reason": reason},
            "research_only": True,
            "trade_authorization": False,
            "execution_allowed": False,
        })
    rejected.sort(key=lambda item: (rejection_priority.get(item["avoid_reason"], 99), item["symbol"]))
    avoids = (neutral_candidates + rejected)[: active.max_avoid_results]
    for index, item in enumerate(avoids, start=1):
        item["rank"] = index
        item.setdefault("avoid_reason", "NO_DIRECTIONAL_SIGNAL")
    return {
        "schema_version": "market-opportunities.v1",
        "status": "READY" if candidates and scan.get("status") == "READY" else (scan.get("status") or "NOT_READY"),
        "generated_at_utc": generated.isoformat(),
        "cadence": cadence,
        "control_state": "RISK_REDUCTION_ONLY",
        "research_only": True,
        "trade_authorization": False,
        "execution_allowed": False,
        "candidates": candidates,
        "opportunities": opportunities,
        "avoids": avoids,
        "rejections": list(scan.get("rejections") or []),
        "blocking_errors": list(scan.get("blocking_errors") or []),
    }


def search_opportunities(payload: Mapping[str, Any], query: str) -> dict[str, Any]:
    """Find one symbol from the latest bounded result without changing its state."""
    needle = str(query or "").strip().upper()
    if not needle:
        return {"status": "INVALID_QUERY", "message": "Enter a Kraken-supported symbol."}
    matches = [item for item in list(payload.get("candidates") or []) if str(item.get("symbol", "")).upper() == needle]
    if not matches:
        return {"status": "NOT_FOUND", "message": f"{needle} was not present in the latest qualified scan."}
    return {"status": "FOUND", "result": matches[0], "research_only": True, "execution_allowed": False, "trade_authorization": False}
