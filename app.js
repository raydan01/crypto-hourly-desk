const $ = selector => document.querySelector(selector);
const escapeHtml = value => String(value ?? "").replace(/[&<>\"]/g, character => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;"}[character]));
const price = value => value == null ? "n/a" : Number(value).toLocaleString(undefined, { maximumSignificantDigits: 8 });
let snapshot = null;

function card(item) {
  const metrics = item.metrics || {};
  const map = item.price_map;
  const bias = String(item.bias || "WATCH").replaceAll("_", " ");
  const tone = bias.includes("LONG") ? "long" : bias.includes("SHORT") ? "short" : "avoid";
  const setup = map ? `<div class="setup"><div><span>Entry zone</span><strong>${price(map.entry_low)} – ${price(map.entry_high)}</strong></div><div><span>Invalidation</span><strong>${price(map.invalidation)}</strong></div><div><span>Target 1</span><strong>${price(map.target_one)}</strong></div><div><span>Target 2</span><strong>${price(map.target_two)}</strong></div></div>` : "";
  return `<article class="card"><div class="card-top"><span class="symbol">${escapeHtml(item.symbol)}</span><span class="bias ${tone}">${escapeHtml(bias)}</span></div><div class="card-meta">${escapeHtml(item.timeframe || "SHORT TERM")} · margin ${escapeHtml(item.margin_status || "unknown")}</div><p class="reason">${escapeHtml(item.explanation?.quick_reason || item.avoid_reason || "Quality screen result")}</p><div class="metrics"><div class="metric"><span>24h change</span><strong>${metrics.change_24h_pct == null ? "n/a" : Number(metrics.change_24h_pct).toFixed(2) + "%"}</strong></div><div class="metric"><span>Spread</span><strong>${metrics.spread_bps == null ? "n/a" : Number(metrics.spread_bps).toFixed(2) + " bps"}</strong></div></div>${setup}</article>`;
}

function render() {
  const choices = (snapshot.opportunities || []).slice(0, 6);
  const avoids = (snapshot.avoids || []).filter(item => item.bias === "AVOID").slice(0, 2);
  const bearish = (snapshot.candidates || []).filter(item => item.bias === "SHORT_RESEARCH").length;
  $("#scan-status").textContent = snapshot.status === "READY" ? "FRESH HOURLY" : String(snapshot.status || "NOT READY").replaceAll("_", " ");
  $("#scan-summary").textContent = `${choices.length} setup${choices.length === 1 ? "" : "s"} cleared the latest Kraken quality screen · captured ${new Date(snapshot.generated_at_utc).toLocaleString()} · ${avoids.length} shown as avoid.`;
  $("#opportunities").innerHTML = choices.length ? choices.map(card).join("") : `<div class="panel"><strong>No directional setup cleared this hour.</strong><p class="muted">${bearish} SHORT research candidate${bearish === 1 ? " was" : "s were"} found in the latest scan. Research labels remain non-executable until independently verified.</p></div>`;
}

async function analyze(query) {
  const symbol = query.trim().toUpperCase();
  if (!symbol) return;
  $("#search-status").textContent = `Looking up ${symbol} on Kraken public data…`;
  const result = $("#search-result"); result.hidden = false; result.innerHTML = "<p class=\"muted\">Fetching public ticker data; no order will be placed.</p>";
  const local = [...(snapshot?.candidates || []), ...(snapshot?.avoids || [])].find(item => String(item.symbol || "").toUpperCase() === symbol);
  if (local) {
    const metrics = local.metrics || {};
    const change = metrics.change_24h_pct == null ? null : Number(metrics.change_24h_pct);
    result.innerHTML = `<h3>${escapeHtml(symbol)} · ${escapeHtml(String(local.bias || "WATCH").replaceAll("_", " "))}</h3><p class="muted">${price(metrics.last)} USD · 24h change ${change == null ? "n/a" : change.toFixed(2) + "%"}</p><p class="muted">${escapeHtml(local.explanation?.quick_reason || local.avoid_reason || "Quality screen result")}</p><p class="muted">Snapshot search is research-only; no order will be placed.</p>`;
    $("#search-status").textContent = "Found in the latest hourly snapshot.";
    return;
  }
  try {
    const pairsResponse = await fetch("https://api.kraken.com/0/public/AssetPairs");
    const pairs = await pairsResponse.json();
    const pairEntry = Object.entries(pairs.result || {}).find(([key, value]) => {
      const wsname = String(value?.wsname || "").toUpperCase();
      const altname = String(value?.altname || key).toUpperCase();
      return value?.status === "online" && (wsname === `${symbol}/USD` || altname === `${symbol}USD` || key.toUpperCase() === `${symbol}USD`);
    });
    const pairKey = pairEntry?.[0];
    if (!pairKey) throw new Error("No Kraken USD spot pair found");
    const tickerResponse = await fetch(`https://api.kraken.com/0/public/Ticker?pair=${encodeURIComponent(pairKey)}`);
    const ticker = await tickerResponse.json();
    const row = ticker.result?.[pairKey] || Object.values(ticker.result || {})[0]; if (!row) throw new Error("Ticker unavailable");
    const last = Number(row.c?.[0]); const opening = Number(row.o); const change = opening ? ((last / opening) - 1) * 100 : null;
    result.innerHTML = `<h3>${escapeHtml(symbol)} · ${change == null ? "NEUTRAL" : change >= 1 ? "LONG RESEARCH" : change <= -1 ? "BEARISH WATCH" : "NEUTRAL"}</h3><p class="muted">${price(last)} USD · 24h change ${change == null ? "n/a" : change.toFixed(2) + "%"}</p><p class="muted">Research only. Verify the market yourself; no order path exists.</p>`;
    $("#search-status").textContent = "Public ticker returned.";
  } catch (error) { result.innerHTML = `<p class="muted">${escapeHtml(error.message)}. Try a Kraken symbol such as BTC or ETH.</p>`; $("#search-status").textContent = "Search unavailable."; }
}

async function boot() {
  const button = $("#refresh-button");
  button.disabled = true; button.textContent = "Refreshing…";
  $("#scan-status").textContent = "REFRESHING";
  try { snapshot = await fetch(`data/market-opportunities-hourly-latest.json?ts=${Date.now()}`, {cache:"no-store"}).then(r => r.json()); render(); }
  catch (error) { $("#scan-status").textContent = "UNAVAILABLE"; $("#scan-summary").textContent = "Hourly snapshot unavailable. Try Refresh scan again."; }
  finally { button.disabled = false; button.textContent = "Refresh scan"; }
}
$("#search-button").addEventListener("click", () => analyze($("#coin-search").value));
$("#coin-search").addEventListener("keydown", event => { if (event.key === "Enter") analyze(event.target.value); });
$("#refresh-button").addEventListener("click", boot);
if ("serviceWorker" in navigator) navigator.serviceWorker.register("service-worker.js").catch(() => {});
boot();
