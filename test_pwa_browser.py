"""Browser proof for the read-only mobile PWA freshness gate."""

from __future__ import annotations

import json
import socket
import subprocess
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).parent


def main() -> None:
    console_errors: list[str] = []
    page_errors: list[str] = []
    server = subprocess.Popen(
        [sys.executable, "-m", "http.server", "8765", "--directory", str(ROOT)],
        cwd=ROOT.parent,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        deadline = time.time() + 10
        while time.time() < deadline:
            with socket.socket() as probe:
                if probe.connect_ex(("127.0.0.1", 8765)) == 0:
                    break
            time.sleep(0.1)
        else:
            raise RuntimeError("local PWA server did not start on port 8765")

        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            page = browser.new_page()
            page.on("console", lambda message: console_errors.append(message.text) if message.type == "error" else None)
            page.on("pageerror", lambda error: page_errors.append(str(error)))
            page.goto("http://127.0.0.1:8765", wait_until="networkidle")
            page.wait_for_function("document.querySelector('#scan-status')?.textContent !== 'REFRESHING'", timeout=90000)
            page.wait_for_timeout(1000)
            priority = {"BULLISH SETUP": 0, "BEARISH SETUP": 1, "WATCH ONLY": 2}

            def inspect_mode(mode: str) -> dict:
                if mode != "hourly":
                    page.locator(f'[data-mode="{mode}"]').click()
                    page.wait_for_function("document.querySelector('#scan-status')?.textContent !== 'REFRESHING'", timeout=90000)
                    page.wait_for_timeout(500)
                status = page.locator("#scan-status").inner_text()
                summary = page.locator("#scan-summary").inner_text()
                cards = page.locator("#opportunities .card")
                biases = page.locator("#opportunities .bias").all_inner_texts()
                bias_order = [priority.get(value, 3) for value in biases]
                stale_count = page.get_by_text("DATA STALE", exact=False).count()
                return {
                    "status": status,
                    "summary": summary,
                    "card_count": cards.count(),
                    "biases": biases,
                    "short_count": biases.count("BEARISH SETUP"),
                    "bias_order": bias_order,
                    "stale_count": stale_count,
                }

            modes = {mode: inspect_mode(mode) for mode in ("hourly", "daily", "long-term")}
            body_text = page.locator("body").inner_text()
            page.locator('[data-direction="SHORT_RESEARCH"]').click()
            page.wait_for_timeout(250)
            short_summary = page.locator("#scan-summary").inner_text()
            short_biases = page.locator("#opportunities .bias").all_inner_texts()
            status = modes["hourly"]["status"]
            cards = page.locator("#opportunities .card")
            stale_count = modes["hourly"]["stale_count"]
            result = {
                "status": status,
                "modes": modes,
                "short_tab_summary": short_summary,
                "short_tab_biases": short_biases,
                "card_count": cards.count(),
                "stale_count": stale_count,
                "console_errors": console_errors,
                "page_errors": page_errors,
                "contains_ada": "ADA" in body_text,
                "contains_live_price": "Live price" in body_text,
            }
            print(json.dumps(result, indent=2))
            for mode_result in modes.values():
                assert mode_result["status"].startswith("FRESH"), result
                assert mode_result["card_count"] == 20, result
                assert mode_result["bias_order"] == sorted(mode_result["bias_order"]), result
                assert mode_result["stale_count"] == 0, result
            assert result["contains_ada"] and result["contains_live_price"], result
            assert "short opportunities" in result["short_tab_summary"], result
            assert all(value == "BEARISH SETUP" for value in result["short_tab_biases"]), result
            assert not console_errors and not page_errors, result
            browser.close()
    finally:
        server.terminate()
        try:
            server.wait(timeout=5)
        except subprocess.TimeoutExpired:
            server.kill()


if __name__ == "__main__":
    main()
