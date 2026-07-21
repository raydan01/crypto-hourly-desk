"""Refresh the read-only weekly-trading snapshot from Kraken public data."""
from __future__ import annotations

import json
from pathlib import Path

from refresh_hourly import build_snapshot

ROOT = Path(__file__).parent
OUTPUT = ROOT / "data" / "market-opportunities-daily-latest.json"


if __name__ == "__main__":
    OUTPUT.write_text(json.dumps(build_snapshot(cadence="daily"), sort_keys=True, separators=(",", ":")) + "\n", encoding="utf-8")
