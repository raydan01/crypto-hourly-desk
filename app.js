const $ = selector => document.querySelector(selector);
const escapeHtml = value => String(value ?? "").replace(/[&<>\"]/g, character => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;"}[character]));
const price = value => value == null ? "n/a" : Number(value).toLocaleString(undefined, { maximumSignificantDigits: 8 });
let snapshot = null;
let activeMode = "hourly";
const biasLabel = {LONG_RESEARCH: "BULLISH SETUP", SHORT_RESEARCH: "BEARISH SETUP", AVOID: "WATCH ONLY"};
const timeframeLabel = {SHORT_TERM: "DAY TRADING", MEDIUM_LONG_TERM: "WEEKLY TRADING", LONG_TERM: "3+ MONTHS"};
const modeConfig = {hourly: {file: "data/market-opportunities-hourly-latest.json", title: "DAY TRADING", eyebrow: "NEXT HOURLY REVIEW"}, daily: {file: "data/market-opportunities-daily-latest.json", title: "WEEKLY TRADING", eyebrow: "NEXT WEEKLY REVIEW"}};

function card(item) {
  const metrics = item.metrics || {};
  const map = item.price_map;
  const biasKey = String(item.bias || "WATCH");
  const bias = biasLabel[biasKey] || biasKey.replaceAll("_", " ");
  const tone = bias.includes("LONG") ? "long" : bias.includes("SHORT") ? "short" : "avoid";
  const setup = map ? `<div class="setup"><div><span>Entry zone</span><strong>${price(map.entry_low)} – ${price(map.entry_high)}</strong></div><div><span>Invalidation</span><strong>${price(map.invalidation)}</strong></div><div><span>Target 1</span><strong>${price(map.target_one)}</strong></div><div><span>Target 2</span><strong>${price(map.target_two)}</strong></div></div>` : "";
  return `<article class="card"><div class="card-top"><span class="symbol">${escapeHtml(item.symbol)}</span><span class="bias ${tone}">${escapeHtml(bias)}</span></div><div class="card-meta">${escapeHtml(timeframeLabel[item.timeframe] || item.timeframe || "INTRADAY")} · margin ${escapeHtml(item.margin_status || "unknown")}</div><p class="reason">${escapeHtml(item.explanation?.quick_reason || item.avoid_reason || "Quality screen result")}</p><div class="metrics"><div class="metric"><span>Live price</span><strong>${price(metrics.last)}</strong></div><div class="metric"><span>24h change</span><strong>${metrics.change_24h_pct == null ? "n/a" : Number(metrics.change_24h_pct).toFixed(2) + "%"}</strong></div><div class="metric"><span>Spread</span><strong>${metrics.spread_bps == null ? "n/a" : Number(metrics.spread_bps).toFixed(2) + " bps"}</strong></div></div>${setup}</article>`;
}

function render() {
  const choices = (snapshot.candidates || []).slice(0, 20);
  const setupCount = (snapshot.opportunities || []).length;
  const avoids = (snapshot.avoids || []).filter(item => item.bias === "AVOID").slice(0, 2);
  const bearish = (snapshot.candidates || []).filter(item => item.bias === "SHORT_RESEARCH").length;
  const mode = modeConfig[activeMode];
  $("#scan-status").textContent = snapshot.status === "READY" ? `FRESH ${mode.title}` : String(snapshot.status || "NOT READY").replaceAll("_", " ");
  const counts = snapshot.selection_counts || {};
  const selection = counts.watchlist_selected != null ? ` · ${counts.watchlist_selected} watched + ${counts.discovery_selected} discovery` : "";
  $("#scan-summary").textContent = `${choices.length} markets shown · ${setupCount} setup${setupCount === 1 ? "" : "s"} cleared the latest Kraken quality screen${selection} · captured ${new Date(snapshot.generated_at_utc).toLocaleString()} · WATCH ONLY cards are monitoring-only.`;
  $("#opportunities").innerHTML = choices.length ? choices.map(card).join("") : `<div class="panel"><strong>No directional setup cleared this hour.</strong><p class="muted">${bearish} bearish candidate${bearish === 1 ? " was" : "s were"} found in the latest scan. All labels are monitoring-only until independently verified.</p></div>`;
}

function renderLongTerm() {
  snapshot = null;
  $("#scan-status").textContent = "WATCHLIST ONLY";
  $("#scan-summary").textContent = "Three-month-plus horizon · no long-term directional model is enabled yet.";
  $("#opportunities").innerHTML = `<div class="panel"><strong>Long-term watchlist only</strong><p class="muted">This horizon needs thesis, fundamentals, tokenomics, and catalyst review. The app will not convert a 24-hour price move into a three-month signal.</p></div>`;
  $("#refresh-button").disabled = true;
  $("#refresh-button").textContent = "Quick scan unavailable";
  $("#deep-scan-button").disabled = true;
  $("#deep-scan-button").textContent = "Deep scan unavailable";
}

async function refreshLiveQuotes() {
  if (!snapshot?.candidates?.length) return 0;
  const pairsResponse = await fetch("https://api.kraken.com/0/public/AssetPairs", {cache: "no-store"});
  const pairs = await pairsResponse.json();
  const pairForSymbol = {};
  for (const [key, value] of Object.entries(pairs.result || {})) {
    if (value?.status !== "online") continue;
    const base = String(value?.wsname || "").split("/")[0].toUpperCase().replace("XBT", "BTC").replace("XDG", "DOGE");
    if (base && !pairForSymbol[base]) pairForSymbol[base] = key;
  }
  const requested = snapshot.candidates.map(item => pairForSymbol[String(item.symbol || "").toUpperCase()]).filter(Boolean);
  if (!requested.length) return 0;
  const tickerResponse = await fetch(`https://api.kraken.com/0/public/Ticker?pair=${encodeURIComponent(requested.join(","))}`, {cache: "no-store"});
  const ticker = await tickerResponse.json();
  let updated = 0;
  for (const item of snapshot.candidates) {
    const key = pairForSymbol[String(item.symbol || "").toUpperCase()];
    const row = ticker.result?.[key] || Object.values(ticker.result || {}).find(value => value?.c && value?.o);
    if (!row) continue;
    const last = Number(row.c?.[0]);
    const bid = Number(row.b?.[0]);
    const ask = Number(row.a?.[0]);
    const opening = Number(row.o);
    if (!Number.isFinite(last)) continue;
    item.metrics = item.metrics || {};
    item.metrics.last = last;
    if (Number.isFinite(bid)) item.metrics.bid = bid;
    if (Number.isFinite(ask)) item.metrics.ask = ask;
    if (Number.isFinite(bid) && Number.isFinite(ask) && (bid + ask) > 0) item.metrics.spread_bps = ((ask - bid) / ((ask + bid) / 2)) * 10000;
    if (Number.isFinite(opening) && opening > 0) item.metrics.change_24h_pct = ((last / opening) - 1) * 100;
    updated += 1;
  }
  snapshot.live_quote_updated_at_utc = new Date().toISOString();
  return updated;
}

function rebuildPriceMap(item) {
  const metrics = item.metrics || {};
  const last = Number(metrics.last); const high = Number(metrics.high_24h); const low = Number(metrics.low_24h);
  if (![last, high, low].every(value => Number.isFinite(value) && value > 0) || high < low) { item.price_map = null; return; }
  const range = Math.max(high - low, last * 0.005);
  if (item.bias === "LONG_RESEARCH") item.price_map = {side: "LONG_RESEARCH", entry_low: Math.max(low, last - range * 0.35), entry_high: last, invalidation: Math.max(0, low - range * 0.25), target_one: last + range * 0.5, target_two: last + range, method: "24-hour range pullback and extension map"};
  else if (item.bias === "SHORT_RESEARCH") item.price_map = {side: "SHORT_RESEARCH", entry_low: last, entry_high: last + range * 0.35, invalidation: high + range * 0.25, target_one: Math.max(0, last - range * 0.5), target_two: Math.max(0, last - range), method: "24-hour range rejection and extension map"};
  else item.price_map = null;
}

async function runDeepScan() {
  if (activeMode === "long-term" || !snapshot?.candidates?.length) return;
  const button = $("#deep-scan-button");
  button.disabled = true; $("#refresh-button").disabled = true; button.textContent = "Scanning history…"; $("#scan-status").textContent = "DEEP SCANNING";
  try {
    await refreshLiveQuotes();
    let completed = 0;
    await Promise.all(snapshot.candidates.map(async item => {
      const pair = encodeURIComponent(item.pair_key || item.symbol);
      const response = await fetch(`https://api.kraken.com/0/public/OHLC?pair=${pair}&interval=60`, {cache: "no-store"});
      const result = await response.json();
      const rows = Object.values(result.result || {}).find(value => Array.isArray(value)) || [];
      const recent = rows.slice(-24);
      const closes = recent.map(row => Number(row[4])).filter(Number.isFinite);
      const highs = recent.map(row => Number(row[2])).filter(Number.isFinite);
      const lows = recent.map(row => Number(row[3])).filter(Number.isFinite);
      if (closes.length >= 3) {
        item.metrics.high_24h = Math.max(...highs); item.metrics.low_24h = Math.min(...lows);
        item.metrics.volatility_24h = (Math.max(...highs) - Math.min(...lows)) / Math.max(...closes[0], 0.00000001);
        item.metrics.history_candles = closes.length;
        rebuildPriceMap(item);
      }
      completed += 1; button.textContent = `Deep scan ${completed}/${snapshot.candidates.length}`;
    }));
    snapshot.deep_scan_updated_at_utc = new Date().toISOString();
    render();
    $("#scan-status").textContent = "DEEP SCAN COMPLETE";
    $("#scan-summary").textContent += ` · Deep scan refreshed ${completed}/${snapshot.candidates.length} hourly histories and rebuilt range levels.`;
  } catch (error) { $("#scan-status").textContent = "DEEP SCAN FAILED"; $("#scan-summary").textContent = `Deep scan could not complete: ${error.message}`; }
  finally { button.disabled = false; $("#refresh-button").disabled = false; button.textContent = "Deep scan"; }
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
    result.innerHTML = `<h3>${escapeHtml(symbol)} · ${escapeHtml(biasLabel[String(local.bias || "WATCH")] || String(local.bias || "WATCH"))}</h3><p class="muted">${price(metrics.last)} USD · 24h change ${change == null ? "n/a" : change.toFixed(2) + "%"}</p><p class="muted">${escapeHtml(local.explanation?.quick_reason || local.avoid_reason || "Quality screen result")}</p><p class="muted">Snapshot search is monitoring-only; no order will be placed.</p>`;
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
    result.innerHTML = `<h3>${escapeHtml(symbol)} · ${change == null ? "NEUTRAL" : change >= 1 ? "BULLISH SETUP" : change <= -1 ? "BEARISH SETUP" : "NEUTRAL"}</h3><p class="muted">${price(last)} USD · 24h change ${change == null ? "n/a" : change.toFixed(2) + "%"}</p><p class="muted">Monitoring only. Verify the market yourself; no order path exists.</p>`;
    $("#search-status").textContent = "Public ticker returned.";
  } catch (error) { result.innerHTML = `<p class="muted">${escapeHtml(error.message)}. Try a Kraken symbol such as BTC or ETH.</p>`; $("#search-status").textContent = "Search unavailable."; }
}

async function boot({manual = false} = {}) {
  if (activeMode === "long-term") { renderLongTerm(); return; }
  $("#deep-scan-button").disabled = false; $("#deep-scan-button").textContent = "Deep scan";
  const button = $("#refresh-button");
  button.disabled = true; button.textContent = "Refreshing…";
  $("#scan-status").textContent = "REFRESHING";
  const previousTimestamp = snapshot?.generated_at_utc;
  try {
    snapshot = await fetch(`${modeConfig[activeMode].file}?ts=${Date.now()}`, {cache:"no-store"}).then(r => r.json());
    const liveCount = await refreshLiveQuotes();
    render();
    const liveTime = snapshot.live_quote_updated_at_utc ? new Date(snapshot.live_quote_updated_at_utc).toLocaleTimeString([], {hour: "numeric", minute: "2-digit"}) : "unavailable";
    $("#scan-summary").textContent += ` · Live Kraken quotes updated ${liveTime} (${liveCount}/${snapshot.candidates.length}); quality screen captured ${new Date(snapshot.generated_at_utc).toLocaleString()}.`;
    if (manual && previousTimestamp && previousTimestamp === snapshot.generated_at_utc) { $("#scan-status").textContent = `LIVE ${modeConfig[activeMode].title}`; }
  }
  catch (error) { $("#scan-status").textContent = "UNAVAILABLE"; $("#scan-summary").textContent = "Hourly snapshot unavailable. Try Refresh scan again."; }
  finally { button.disabled = false; button.textContent = "Refresh scan"; }
}
$("#search-button").addEventListener("click", () => analyze($("#coin-search").value));
$("#coin-search").addEventListener("keydown", event => { if (event.key === "Enter") analyze(event.target.value); });
$("#refresh-button").addEventListener("click", () => boot({manual: true}));
$("#deep-scan-button").addEventListener("click", runDeepScan);
document.querySelectorAll(".tab").forEach(tab => tab.addEventListener("click", () => { activeMode = tab.dataset.mode; document.querySelectorAll(".tab").forEach(item => { const selected = item === tab; item.classList.toggle("active", selected); item.setAttribute("aria-selected", String(selected)); }); $("#horizon-label").textContent = modeConfig[activeMode]?.eyebrow || "LONG-TERM HORIZON"; boot(); }));
if ("serviceWorker" in navigator) navigator.serviceWorker.register("service-worker.js").catch(() => {});
boot();
