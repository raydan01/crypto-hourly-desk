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
    if change <= active.short_change_pct and margin_status == "verified_enabled":
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
    config: OpportunityConfig | None = None,
) -> dict[str, Any]:
    """Decorate scanner candidates for the UI with bounded research labels."""
    active = config or OpportunityConfig()
    generated = _utc(generated_at_utc)
    candidates = []
    for item in list(scan.get("candidates") or [])[: active.max_results]:
        metrics = dict(item.get("metrics") or {})
        change = metrics.get("change_24h_pct")
        margin_status = str(item.get("margin_status") or "unknown")
        bias = classify_bias(change, margin_status, active)
        quick_reason = "Quality filters passed; directional movement cleared the research threshold." if bias != "AVOID" else "Quality filters passed, but directional movement did not clear the research threshold."
        candidates.append({
            **item,
            "bias": bias,
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
