# Production-origin startup gate

Status for fix round 1: **NOT RUN; release acceptance remains pending**.

The repository and supplied environment do not name the production HTTPS origin. This fix round also prohibits live network access. Do not infer a production startup pass from the local Edge CDP check. Before release, set the exact production origin in the release record and open that URL in current Edge and iPhone Safari. Confirm the production HTTPS document and app assets load, the Hype bootstrap reports `NO DATA` without fabricated items before its first collector success, source health is visible, and a successful scheduled capture replaces the bootstrap artifact. Record the URL, UTC time, browser versions, and screenshots in the release evidence.

Local replay evidence is reproducible with `tests/browser_cdp.mjs`; it does not satisfy the production-origin gate.
