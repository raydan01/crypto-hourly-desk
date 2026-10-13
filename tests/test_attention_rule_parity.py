"""Shared attention-rule outcomes for the recorded collector captures."""
from __future__ import annotations

import json
from pathlib import Path

import social_context


ROOT = Path(__file__).resolve().parents[1]
CAPTURES = ROOT / "tests" / "fixtures" / "recorded"


def _capture(name: str) -> dict:
    return json.loads((CAPTURES / name).read_text(encoding="utf-8"))


def _item(capture: dict, coin_id: str) -> dict:
    return next(row for row in capture["items"] if row["coingecko_id"] == coin_id)


def test_python_evaluator_replays_binding_real_capture_outcomes():
    rules = social_context.load_attention_rules()
    first = _capture("live-collector-output-f494d74.json")
    second = _capture("live-collector-output-5f40129-second-capture.json")
    old_by_id = {item["coingecko_id"]: item for item in first["items"]}
    expected = {
        "crawlerpad": "RISING",
        "quantus": "MIXED",
        "bunker-mode": "MIXED",
        "identity-md-6900": "FADING",
    }
    states = {}
    for coin_id, state in expected.items():
        item = _item(second, coin_id)
        prior = old_by_id[coin_id]
        prior_volume = prior["market"]["volume_24h_usd"]
        volume_change = (item["market"]["volume_24h_usd"] / prior_volume - 1) * 100
        rank_change = prior["trending"]["rank"] - item["trending"]["rank"]
        actual = social_context.evaluate_momentum_state(rank_change, volume_change, rules=rules)
        assert actual == state
        states[coin_id] = actual
    # A coin without a valid prior capture must not inherit or infer a direction.
    assert social_context.evaluate_momentum_state(None, None, has_valid_history=False, rules=rules) == "INSUFFICIENT_HISTORY"
    assert states == expected


def test_primary_pair_and_secondary_selling_pressure_match_binding_cases():
    rules = social_context.load_attention_rules()
    capture = _capture("live-collector-output-f494d74.json")
    crawler = _item(capture, "crawlerpad")
    primary = social_context.select_primary_pair(crawler["dex_pairs"], rules)
    assert primary["dex_id"] == "pumpswap"
    crawler_observations = social_context.evaluate_attention_observations(crawler["dex_pairs"], crawler["market"], rules)
    assert all(row.get("dex_id") == "pumpswap" for row in crawler_observations if row["kind"] != "SELLING_PRESSURE")
    assert all(row.get("pair_address") == primary["pair_address"] for row in crawler_observations if row["kind"] != "SELLING_PRESSURE")

    pengu = _item(capture, "pudgy-penguins")
    twenty_forty = next(pair for pair in pengu["dex_pairs"] if (pair.get("buys_sells_by_period") or {}).get("h24") == {"buys": 20, "sells": 40})
    pengu_observations = social_context.evaluate_attention_observations(pengu["dex_pairs"], pengu["market"], rules)
    neutral = [row for row in pengu_observations if row["kind"] == "SELLING_PRESSURE" and row.get("pair_address") == twenty_forty["pair_address"]]
    assert len(neutral) == 1
    assert not any(row["kind"] == "BUY_SELL_IMBALANCE" and row.get("pair_address") == twenty_forty["pair_address"] for row in pengu_observations)
    assert rules["observations"]["selling_pressure"]["count_as_fomo_flag"] is False


def test_rule_table_is_the_python_threshold_source():
    rules = social_context.load_attention_rules()
    assert rules["schema"] == "market-attention-rules.v1"
    assert rules["version"] == 1
    assert rules["momentum"]["volume_noise_band_percent_inclusive"] == 5
    assert social_context.ATTENTION_RULES_PATH == ROOT / "data" / "attention-rules.json"
    # Exact +/-5% remains in the inclusive flat/noise band; outside it may direct momentum.
    assert social_context.evaluate_momentum_state(0, 5, rules=rules) == "FLAT"
    assert social_context.evaluate_momentum_state(0, -5, rules=rules) == "FLAT"
    assert social_context.evaluate_momentum_state(0, 5.0001, rules=rules) == "RISING"

