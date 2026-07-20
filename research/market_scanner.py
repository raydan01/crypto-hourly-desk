"""Deterministic, read-only market candidate scanner.

The scanner evaluates only the explicit eligible-market universe supplied by
the caller.  It does not discover markets, contact providers, place orders, or
make portfolio-level recommendations.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
import math
from typing import Any, Iterable, Mapping, Sequence


SCANNER_SCHEMA_VERSION = "market-scanner.v1"


@dataclass(frozen=True)
class ScannerConfig:
    """Conservative defaults for a liquid, fresh, moderate-volatility screen."""

    minimum_quote_volume_24h: float = 1_000_000.0
    maximum_spread_bps: float = 50.0
    minimum_volatility_24h: float = 0.005
    maximum_volatility_24h: float = 0.20
    maximum_snapshot_age_seconds: int = 900


def _blocked(code: str, detail: str, *, observed_at_utc: str | None = None) -> dict[str, Any]:
    return {
        "schema_version": SCANNER_SCHEMA_VERSION,
        "status": "BLOCKED",
        "trade_authorization": False,
        "execution_allowed": False,
        "research_only": True,
        "observed_at_utc": observed_at_utc,
        "candidates": [],
        "rejections": [],
        "blocking_errors": [{"code": code, "detail": detail}],
    }


def _number(value: Any, field: str) -> float:
    if isinstance(value, bool):
        raise ValueError(f"{field} must be a finite number")
    number = float(value)
    if not math.isfinite(number):
        raise ValueError(f"{field} must be a finite number")
    return number


def _timestamp(value: Any, field: str) -> datetime:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{field} must be an ISO-8601 UTC timestamp")
    text = value.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    parsed = datetime.fromisoformat(text)
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ValueError(f"{field} must include a UTC offset")
    return parsed.astimezone(timezone.utc)


def _symbols(eligible_markets: Iterable[str]) -> list[str]:
    if isinstance(eligible_markets, (str, bytes)):
        raise ValueError("eligible_markets must be an iterable of symbols")
    symbols = []
    for raw in eligible_markets:
        if not isinstance(raw, str) or not raw.strip():
            raise ValueError("eligible market symbols must be non-empty strings")
        symbols.append(raw.strip().upper())
    if not symbols:
        raise ValueError("eligible_markets must not be empty")
    if len(set(symbols)) != len(symbols):
        raise ValueError("eligible_markets must not contain duplicates")
    return sorted(symbols)


def _validate_config(config: ScannerConfig) -> None:
    numeric = (
        config.minimum_quote_volume_24h,
        config.maximum_spread_bps,
        config.minimum_volatility_24h,
        config.maximum_volatility_24h,
        config.maximum_snapshot_age_seconds,
    )
    if any(not math.isfinite(float(value)) for value in numeric):
        raise ValueError("scanner configuration values must be finite")
    if config.minimum_quote_volume_24h <= 0:
        raise ValueError("minimum_quote_volume_24h must be positive")
    if config.maximum_spread_bps <= 0:
        raise ValueError("maximum_spread_bps must be positive")
    if not 0 <= config.minimum_volatility_24h < config.maximum_volatility_24h:
        raise ValueError("volatility bounds must have a positive range")
    if config.maximum_snapshot_age_seconds <= 0:
        raise ValueError("maximum_snapshot_age_seconds must be positive")


def _candidate(snapshot: Mapping[str, Any], observed: datetime, config: ScannerConfig) -> tuple[dict[str, Any] | None, str | None]:
    required = ("symbol", "observed_at_utc", "bid", "ask", "last", "volume_24h_quote", "volatility_24h")
    missing = [field for field in required if field not in snapshot]
    symbol = str(snapshot.get("symbol", "")).strip().upper()
    if missing:
        return None, f"MISSING_FIELDS:{','.join(missing)}"
    if not symbol:
        return None, "INVALID_SYMBOL"
    try:
        captured = _timestamp(snapshot["observed_at_utc"], "snapshot.observed_at_utc")
        bid = _number(snapshot["bid"], "bid")
        ask = _number(snapshot["ask"], "ask")
        last = _number(snapshot["last"], "last")
        volume = _number(snapshot["volume_24h_quote"], "volume_24h_quote")
        volatility = _number(snapshot["volatility_24h"], "volatility_24h")
    except (TypeError, ValueError, OverflowError) as exc:
        return None, f"INVALID_FIELDS:{exc}"
    if captured > observed:
        return None, "SNAPSHOT_FROM_FUTURE"
    age = (observed - captured).total_seconds()
    if age > config.maximum_snapshot_age_seconds:
        return None, "STALE_SNAPSHOT"
    if age < 0 or bid <= 0 or ask <= 0 or last <= 0 or ask < bid:
        return None, "INVALID_PRICE_OR_TIME_RANGE"
    if volume < config.minimum_quote_volume_24h:
        return None, "INSUFFICIENT_LIQUIDITY"
    midpoint = (bid + ask) / 2
    spread_bps = (ask - bid) / midpoint * 10_000
    if spread_bps > config.maximum_spread_bps:
        return None, "SPREAD_TOO_WIDE"
    if not config.minimum_volatility_24h <= volatility <= config.maximum_volatility_24h:
        return None, "VOLATILITY_OUT_OF_RANGE"

    liquidity_score = min(volume / config.minimum_quote_volume_24h, 3.0) / 3.0
    spread_score = max(0.0, 1.0 - spread_bps / config.maximum_spread_bps)
    midpoint_volatility = (config.minimum_volatility_24h + config.maximum_volatility_24h) / 2
    volatility_range = config.maximum_volatility_24h - config.minimum_volatility_24h
    volatility_score = 1.0 - abs(volatility - midpoint_volatility) / (volatility_range / 2)
    freshness_score = max(0.0, 1.0 - age / config.maximum_snapshot_age_seconds)
    score = round(0.45 * liquidity_score + 0.25 * spread_score + 0.20 * volatility_score + 0.10 * freshness_score, 8)
    return {
        "symbol": symbol,
        "rank_score": score,
        "research_only": True,
        "trade_authorization": False,
        "execution_allowed": False,
        "metrics": {
            "last": last,
            "bid": bid,
            "ask": ask,
            "high_24h": snapshot.get("high_24h"),
            "low_24h": snapshot.get("low_24h"),
            "spread_bps": round(spread_bps, 8),
            "volume_24h_quote": volume,
            "volatility_24h": volatility,
            "snapshot_age_seconds": round(age, 3),
        },
        "selection_reasons": ["eligible_market", "liquidity_pass", "spread_pass", "volatility_pass", "freshness_pass"],
    }, None


def scan_markets(
    eligible_markets: Iterable[str],
    snapshots: Sequence[Mapping[str, Any]],
    *,
    observed_at_utc: str,
    config: ScannerConfig | None = None,
) -> dict[str, Any]:
    """Return ranked research candidates for the supplied universe only.

    Invalid top-level inputs fail closed with ``BLOCKED``.  Invalid individual
    snapshots are rejected and cannot produce a candidate.
    """
    try:
        symbols = _symbols(eligible_markets)
        observed = _timestamp(observed_at_utc, "observed_at_utc")
        active_config = config or ScannerConfig()
        _validate_config(active_config)
        if not isinstance(snapshots, Sequence) or isinstance(snapshots, (str, bytes)) or not snapshots:
            raise ValueError("snapshots must be a non-empty sequence")
    except (TypeError, ValueError, OverflowError) as exc:
        return _blocked("INVALID_INPUT", str(exc), observed_at_utc=observed_at_utc)

    candidates: list[dict[str, Any]] = []
    rejections: list[dict[str, Any]] = []
    seen: set[str] = set()
    for snapshot in snapshots:
        if not isinstance(snapshot, Mapping):
            rejections.append({"symbol": None, "reason": "INVALID_SNAPSHOT"})
            continue
        symbol = str(snapshot.get("symbol", "")).strip().upper() or None
        if symbol not in symbols:
            rejections.append({"symbol": symbol, "reason": "OUTSIDE_ELIGIBLE_UNIVERSE"})
            continue
        if symbol in seen:
            rejections.append({"symbol": symbol, "reason": "DUPLICATE_SNAPSHOT"})
            continue
        seen.add(symbol)
        candidate, reason = _candidate(snapshot, observed, active_config)
        if candidate:
            candidates.append(candidate)
        else:
            metrics = {field: snapshot.get(field) for field in ("last", "bid", "ask", "volume_24h_quote", "volatility_24h", "change_24h_pct") if field in snapshot}
            rejections.append({"symbol": symbol, "reason": reason, "metrics": metrics})

    candidates.sort(key=lambda item: (-item["rank_score"], item["symbol"]))
    for index, candidate in enumerate(candidates, start=1):
        candidate["rank"] = index
    return {
        "schema_version": SCANNER_SCHEMA_VERSION,
        "status": "READY" if candidates else "NO_CANDIDATES",
        "trade_authorization": False,
        "execution_allowed": False,
        "research_only": True,
        "observed_at_utc": observed_at_utc,
        "eligible_market_count": len(symbols),
        "evaluated_snapshot_count": len(snapshots),
        "candidates": candidates,
        "rejections": rejections,
        "blocking_errors": [],
    }
