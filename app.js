const $ = selector => document.querySelector(selector);
const escapeHtml = value => String(value ?? "").replace(/[&<>\"]/g, character => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;"}[character]));
const price = value => value == null ? "n/a" : Number(value).toLocaleString(undefined, { maximumSignificantDigits: 8 });
const APP_BUILD_ID = "freshness-gate-v1";
const MAX_LIVE_QUOTE_AGE_SECONDS = 120;
let snapshot = null;
let activeMode = "hourly";
let activeDirection = "all";
const biasLabel = {LONG_RESEARCH: "BULLISH SETUP", SHORT_RESEARCH: "BEARISH SETUP", AVOID: "WATCH ONLY"};
const timeframeLabel = {SHORT_TERM: "DAY TRADING", MEDIUM_LONG_TERM: "WEEKLY TRADING", LONG_TERM: "3+ MONTHS"};
const modeConfig = {hourly: {file: "data/market-opportunities-hourly-latest.json", title: "DAY TRADING", eyebrow: "NEXT HOURLY REVIEW", interval: 60, historyLabel: "hourly"}, daily: {file: "data/market-opportunities-daily-latest.json", title: "WEEKLY TRADING", eyebrow: "NEXT WEEKLY REVIEW", interval: 1440, historyLabel: "daily"}, "long-term": {file: "data/market-opportunities-long-term-latest.json", title: "3+ MONTHS", eyebrow: "NEXT LONG-TERM REVIEW", interval: 1440, historyLabel: "daily"}};
const DEEP_SCAN_MIN_MS = 15000;
const REQUEST_TIMEOUT_MS = 30000;

function freshUrl(url) {
  return `${url}${url.includes("?") ? "&" : "?"}_fresh=${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

function utcAgeSeconds(value) {
  const timestamp = Date.parse(value || "");
  if (!Number.isFinite(timestamp)) return null;
  return (Date.now() - timestamp) / 1000;
}

function renderDataStale(reason) {
  $("#scan-status").textContent = "DATA STALE";
  $("#scan-summary").textContent = `${reason} Build ${APP_BUILD_ID}. No setup or price map is actionable until a complete live refresh succeeds.`;
  $("#opportunities").innerHTML = `<div class="panel"><strong>DATA STALE — NO SIGNAL</strong><p class="muted">${escapeHtml(reason)}</p><p class="muted">Required: ${MAX_LIVE_QUOTE_AGE_SECONDS}-second maximum quote age, complete candidate coverage, and compatible fresh range data.</p></div>`;
}

function liveFreshness() {
  if (!snapshot || !Array.isArray(snapshot.candidates) || !snapshot.candidates.length) return {ok: false, reason: "No market snapshot is loaded."};
  const expected = Number(snapshot.live_quote_expected_count || snapshot.candidates.length);
  const received = Number(snapshot.live_quote_count || 0);
  const missing = snapshot.candidates.filter(item => item.live_quote_status !== "FRESH").map(item => item.symbol).filter(Boolean);
  if (!snapshot.live_quote_complete || received !== expected || missing.length) {
    return {ok: false, reason: `Live Kraken quote refresh incomplete (${received}/${expected}); missing: ${missing.join(", ") || "unknown"}.`};
  }
  const age = utcAgeSeconds(snapshot.live_quote_updated_at_utc);
  if (age == null || age < -5 || age > MAX_LIVE_QUOTE_AGE_SECONDS) {
    return {ok: false, reason: `Live Kraken quote batch is ${age == null ? "undated" : `${Math.max(0, age).toFixed(0)} seconds old`}.`};
  }
  return {ok: true, age};
}

async function fetchFreshJson(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeout || REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(freshUrl(url), {cache: "no-store", signal: controller.signal, ...options});
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    if (payload?.error?.length) throw new Error(payload.error.join(", "));
    return payload;
  } finally { clearTimeout(timeout); }
}

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function buildUsdPairMap(pairResult) {
  const pairForSymbol = {};
  for (const [key, value] of Object.entries(pairResult || {})) {
    if (value?.status !== "online") continue;
    const wsname = String(value?.wsname || "").toUpperCase();
    const [rawBase, quote] = wsname.split("/");
    if (quote !== "USD") continue;
    const base = rawBase.replace("XBT", "BTC").replace("XDG", "DOGE");
    if (base && !pairForSymbol[base]) pairForSymbol[base] = key;
  }
  return pairForSymbol;
}

function card(item) {
  const metrics = item.metrics || {};
  const map = item.price_map;
  const biasKey = String(item.bias || "WATCH");
  const bias = biasLabel[biasKey] || biasKey.replaceAll("_", " ");
  const tone = bias.includes("LONG") ? "long" : bias.includes("SHORT") ? "short" : "avoid";
  const setup = map ? `<div class="setup"><div><span>Entry zone</span><strong>${price(map.entry_low)} – ${price(map.entry_high)}</strong></div><div><span>Invalidation</span><strong>${price(map.invalidation)}</strong></div><div><span>Target 1</span><strong>${price(map.target_one)}</strong></div><div><span>Target 2</span><strong>${price(map.target_two)}</strong></div></div>` : "";
  return `<article class="card"><div class="card-top"><span class="symbol">${escapeHtml(item.symbol)}</span><span class="bias ${tone}">${escapeHtml(bias)}</span></div><div class="card-meta">#${item.rank || "-"} · ${escapeHtml(timeframeLabel[item.timeframe] || item.timeframe || "INTRADAY")} · margin ${escapeHtml(item.margin_status || "unknown")}</div><div class="score-row"><strong>${Number(item.opportunity_score || 0).toFixed(0)}/100</strong><span>${escapeHtml(item.confidence_band || "LOW")} confidence</span></div><p class="reason">${escapeHtml(item.explanation?.quick_reason || item.avoid_reason || "Quality screen result")}</p><div class="metrics"><div class="metric"><span>Live price</span><strong>${price(metrics.last)}</strong></div><div class="metric"><span>24h change</span><strong>${metrics.change_24h_pct == null ? "n/a" : Number(metrics.change_24h_pct).toFixed(2) + "%"}</strong></div><div class="metric"><span>Spread</span><strong>${metrics.spread_bps == null ? "n/a" : Number(metrics.spread_bps).toFixed(2) + " bps"}</strong></div></div>${setup}</article>`;
}

const displayPriority = {LONG_RESEARCH: 0, SHORT_RESEARCH: 1, AVOID: 2};

function orderDisplayChoices(items) {
  return items.map((item, index) => ({item, index})).sort((left, right) => {
    const leftPriority = displayPriority[left.item.bias] ?? 3;
    const rightPriority = displayPriority[right.item.bias] ?? 3;
    if (leftPriority !== rightPriority) return leftPriority - rightPriority;
    const leftRank = Number(left.item.rank);
    const rightRank = Number(right.item.rank);
    if (Number.isFinite(leftRank) && Number.isFinite(rightRank) && leftRank !== rightRank) return leftRank - rightRank;
    return left.index - right.index;
  }).map(entry => entry.item);
}

function render() {
  const freshness = liveFreshness();
  if (!freshness.ok) {
    renderDataStale(freshness.reason);
    return;
  }
  const allChoices = snapshot.candidates || [];
  const choices = orderDisplayChoices(activeDirection === "all" ? allChoices : allChoices.filter(item => item.bias === activeDirection)).slice(0, 20);
  const setupCount = (snapshot.opportunities || []).length;
  const avoids = (snapshot.avoids || []).filter(item => item.bias === "AVOID").slice(0, 2);
  const bearish = (snapshot.candidates || []).filter(item => item.bias === "SHORT_RESEARCH").length;
  const mode = modeConfig[activeMode];
  $("#scan-status").textContent = snapshot.status === "READY" ? `FRESH ${mode.title}` : String(snapshot.status || "NOT READY").replaceAll("_", " ");
  const counts = snapshot.selection_counts || {};
  const selection = counts.watchlist_selected != null ? ` · ${counts.watchlist_selected} watched + ${counts.discovery_selected} discovery` : "";
  const directionLabel = activeDirection === "all" ? "all directions" : activeDirection === "LONG_RESEARCH" ? "long opportunities" : activeDirection === "SHORT_RESEARCH" ? "short opportunities" : "avoid/watch markets";
  $("#scan-summary").textContent = `${choices.length} ${directionLabel} ranked by combined market + social score · ${setupCount} setup${setupCount === 1 ? "" : "s"} cleared the latest screen${selection} · captured ${new Date(snapshot.generated_at_utc).toLocaleString()} · WATCH ONLY cards are monitoring-only.`;
  const artifactAge = utcAgeSeconds(snapshot.generated_at_utc);
  $("#scan-summary").textContent += ` Â· live quotes ${snapshot.live_quote_source || "unknown source"}, ${freshness.age.toFixed(0)}s old (${snapshot.live_quote_count}/${snapshot.live_quote_expected_count}) Â· artifact age ${artifactAge == null ? "unknown" : `${Math.max(0, artifactAge).toFixed(0)}s`} Â· build ${APP_BUILD_ID}.`;
  $("#opportunities").innerHTML = choices.length ? choices.map(card).join("") : `<div class="panel"><strong>No directional setup cleared this hour.</strong><p class="muted">${bearish} bearish candidate${bearish === 1 ? " was" : "s were"} found in the latest scan. All labels are monitoring-only until independently verified.</p></div>`;
  renderSocial(snapshot.social_context || {});
}

function renderSocial(social) {
  const items = (social.items || []).slice(0, 10);
  const health = social.source_health || {};
  $("#social-status").textContent = String(social.status || "NO DATA").replaceAll("_", " ");
  $("#social-summary").textContent = items.length ? `${items.length} attention-ranked projects captured ${social.captured_at_utc ? new Date(social.captured_at_utc).toLocaleString() : ""}.` : "No social/news context was returned.";
  $("#social-health").innerHTML = Object.entries(health).map(([name, value]) => `<span>${escapeHtml(name.replaceAll("_", " "))}: <strong>${escapeHtml(value.status || "UNKNOWN")}${value.coverage == null ? "" : ` · ${Number(value.coverage).toFixed(0)}%`}</strong></span>`).join("");
  $("#social-items").innerHTML = items.length ? items.map(item => `<article class="social-item"><div><strong>${escapeHtml(item.symbol)}</strong><span>${escapeHtml(item.name)}</span></div><b>${Number(item.attention_score || 0).toFixed(0)} attention</b><small>CoinGecko #${item.rank} · News ${item.source_counts?.google_news || 0} · Reddit ${item.source_counts?.reddit || 0}</small></article>`).join("") : `<p class="muted">Social sources are unavailable or still refreshing.</p>`;
}

function renderLongTerm() {
  return boot();
}

async function refreshLiveQuotes() {
  if (!snapshot?.candidates?.length) return 0;
  const expected = snapshot.candidates.length;
  const refreshStartedAt = new Date().toISOString();
  snapshot.live_quote_expected_count = expected;
  snapshot.live_quote_count = 0;
  snapshot.live_quote_complete = false;
  snapshot.live_quote_source = "Kraken public Ticker; cache-busted no-store request";
  snapshot.live_quote_started_at_utc = refreshStartedAt;
  snapshot.live_quote_failed_symbols = [];
  snapshot.candidates.forEach(item => { item.live_quote_status = "PENDING"; });
  const pairs = await fetchFreshJson("https://api.kraken.com/0/public/AssetPairs");
  const pairForSymbol = buildUsdPairMap(pairs.result);
  const requested = snapshot.candidates.map(item => pairForSymbol[String(item.symbol || "").toUpperCase()]).filter(Boolean);
  if (!requested.length) {
    snapshot.live_quote_failed_symbols = snapshot.candidates.map(item => item.symbol).filter(Boolean);
    return 0;
  }
  const ticker = await fetchFreshJson(`https://api.kraken.com/0/public/Ticker?pair=${encodeURIComponent(requested.join(","))}`);
  let updated = 0;
  const failed = [];
  for (const item of snapshot.candidates) {
    const symbol = String(item.symbol || "").toUpperCase();
    const key = pairForSymbol[symbol];
    const row = ticker.result?.[key];
    if (!key || !row) { failed.push(symbol); continue; }
    const last = Number(row.c?.[0]);
    const bid = Number(row.b?.[0]);
    const ask = Number(row.a?.[0]);
    const opening = Number(row.o);
    const high = Number(row.h?.[1]);
    const low = Number(row.l?.[1]);
    const volume = Number(row.v?.[1]);
    if (![last, bid, ask, opening, high, low, volume].every(Number.isFinite) || last <= 0 || bid <= 0 || ask <= 0 || opening <= 0 || high <= 0 || low <= 0 || volume < 0 || last < low || last > high) {
      failed.push(symbol);
      continue;
    }
    item.metrics = item.metrics || {};
    item.metrics.last = last;
    item.metrics.bid = bid;
    item.metrics.ask = ask;
    item.metrics.high_24h = high;
    item.metrics.low_24h = low;
    item.metrics.volume_24h_quote = volume * last;
    item.metrics.volatility_24h = (high - low) / opening;
    item.metrics.change_24h_pct = ((last / opening) - 1) * 100;
    item.metrics.spread_bps = ((ask - bid) / ((ask + bid) / 2)) * 10000;
    item.metrics.observed_at_utc = refreshStartedAt;
    item.live_quote_status = "FRESH";
    item.live_quote_source = "Kraken public Ticker";
    item.live_quote_pair = key;
    updated += 1;
  }
  const refreshedAt = new Date().toISOString();
  snapshot.live_quote_updated_at_utc = refreshedAt;
  snapshot.live_quote_count = updated;
  snapshot.live_quote_failed_symbols = failed;
  snapshot.live_quote_complete = updated === expected && failed.length === 0;
  snapshot.candidates.forEach(item => { if (item.live_quote_status === "FRESH") item.live_quote_updated_at_utc = refreshedAt; });
  return updated;
}

function rebuildPriceMap(item) {
  const metrics = item.metrics || {};
  const last = Number(metrics.last); const high = Number(metrics.high_24h); const low = Number(metrics.low_24h);
  if (![last, high, low].every(value => Number.isFinite(value) && value > 0) || high < low || last < low || last > high) { item.price_map = null; item.price_map_status = "INVALID_FRESH_RANGE"; return; }
  const range = Math.max(high - low, last * 0.005);
  if (item.bias === "LONG_RESEARCH") item.price_map = {side: "LONG_RESEARCH", entry_low: Math.max(low, last - range * 0.35), entry_high: last, invalidation: Math.max(0, low - range * 0.25), target_one: last + range * 0.5, target_two: last + range, method: "24-hour range pullback and extension map"};
  else if (item.bias === "SHORT_RESEARCH" && item.margin_status === "verified_enabled") item.price_map = {side: "SHORT_RESEARCH", entry_low: last, entry_high: last + range * 0.35, invalidation: high + range * 0.25, target_one: Math.max(0, last - range * 0.5), target_two: Math.max(0, last - range), method: "fresh Kraken 24-hour range rejection and extension map"};
  else item.price_map = null;
  item.price_map_status = item.price_map ? "FRESH" : "NONE";
}

function recalculateLiveRanking() {
  if (!snapshot?.candidates?.length) return;
  const socialBySymbol = Object.fromEntries((snapshot.social_context?.items || []).map(item => [String(item.symbol || "").toUpperCase(), item]));
  const clamp = value => Math.max(-1, Math.min(1, value));
  for (const item of snapshot.candidates) {
    const metrics = item.metrics || {};
    const change = Number(metrics.change_24h_pct) || 0;
    const spread = Math.max(0, Number(metrics.spread_bps) || 0);
    const volume = Math.max(0, Number(metrics.volume_24h_quote) || 0);
    const volatility = Math.max(0, Number(metrics.volatility_24h) || 0);
    const marketDirection = clamp(change / 5);
    const directionalStrength = Math.min(Math.abs(change) / 5, 1) * 100;
    const liquidityScore = volume ? Math.min(100, Math.sqrt(volume / 10000000) * 100) : 0;
    const spreadScore = Math.max(0, 100 - spread * 10);
    const volatilityScore = Math.max(0, 100 - Math.abs(volatility - 0.04) * 1200);
    const marketScore = directionalStrength * 0.45 + liquidityScore * 0.25 + spreadScore * 0.15 + volatilityScore * 0.15;
    const social = socialBySymbol[String(item.symbol || "").toUpperCase()] || {};
    const counts = social.source_counts || {};
    const attention = Math.max(0, Math.min(100, Number(social.attention_score) || 0));
    const socialScore = Math.min(100, attention * 0.8 + Math.min(20, (Number(counts.google_news) || 0) * 0.5 + (Number(counts.reddit) || 0)));
    const socialDirection = social.price_change_24h_pct == null ? 0 : clamp(Number(social.price_change_24h_pct) / 5);
    const combinedDirection = marketDirection * 0.70 + socialDirection * 0.30;
    const score = Number((marketScore * 0.70 + socialScore * 0.30).toFixed(2));
    item.opportunity_score = score;
    item.confidence_band = score >= 70 ? "HIGH" : score >= 45 ? "MODERATE" : "LOW";
    item.bias = combinedDirection >= 0.25 ? "LONG_RESEARCH" : combinedDirection <= -0.25 && item.margin_status === "verified_enabled" ? "SHORT_RESEARCH" : "AVOID";
    item.score_breakdown = {...(item.score_breakdown || {}), score, band: item.confidence_band, bias: item.bias, market_score: Number(marketScore.toFixed(2)), social_score: Number(socialScore.toFixed(2)), combined_direction: Number(combinedDirection.toFixed(4))};
    item.explanation = {...(item.explanation || {}), directional_change_24h_pct: change, quick_reason: item.bias === "LONG_RESEARCH" ? "Fresh Kraken quote passed the bullish research threshold." : item.bias === "SHORT_RESEARCH" ? "Fresh Kraken quote passed the bearish research threshold; short execution remains permission-gated." : "Fresh Kraken quote did not clear the directional research threshold."};
    rebuildPriceMap(item);
  }
  snapshot.candidates.sort((a, b) => Number(b.opportunity_score || 0) - Number(a.opportunity_score || 0) || String(a.symbol || "").localeCompare(String(b.symbol || "")));
  snapshot.candidates.forEach((item, index) => { item.rank = index + 1; });
  snapshot.opportunities = snapshot.candidates.filter(item => item.bias !== "AVOID");
  snapshot.avoids = snapshot.candidates.filter(item => item.bias === "AVOID");
}

async function runDeepScan() {
  if (!snapshot?.candidates?.length) return;
  const button = $("#deep-scan-button");
  button.disabled = true; $("#refresh-button").disabled = true; button.textContent = "Scanning history…"; $("#scan-status").textContent = "DEEP SCANNING";
  const startedAt = performance.now();
  try {
    await refreshLiveQuotes();
    if (!snapshot.live_quote_complete) throw new Error(`complete live quote refresh failed (${snapshot.live_quote_count}/${snapshot.live_quote_expected_count})`);
    recalculateLiveRanking();
    const pairs = await fetchFreshJson("https://api.kraken.com/0/public/AssetPairs");
    const pairForSymbol = buildUsdPairMap(pairs.result);
    const results = await Promise.all(snapshot.candidates.map(async item => {
      const pair = encodeURIComponent(pairForSymbol[String(item.symbol || "").toUpperCase()] || item.pair_key || item.symbol);
      try {
        const result = await fetchFreshJson(`https://api.kraken.com/0/public/OHLC?pair=${pair}&interval=${modeConfig[activeMode].interval}`);
        const rows = Object.values(result.result || {}).find(value => Array.isArray(value)) || [];
        const recent = rows.slice(activeMode === "hourly" ? -24 : -90);
        const closes = recent.map(row => Number(row[4])).filter(Number.isFinite);
        const highs = recent.map(row => Number(row[2])).filter(Number.isFinite);
        const lows = recent.map(row => Number(row[3])).filter(Number.isFinite);
        if (closes.length < 3) throw new Error("insufficient OHLC candles");
        item.metrics.high_24h = Math.max(...highs); item.metrics.low_24h = Math.min(...lows);
        item.metrics.volatility_24h = (Math.max(...highs) - Math.min(...lows)) / Math.max(closes[0], 0.00000001);
        item.metrics.history_candles = closes.length;
        item.deep_scan_observed_at_utc = new Date().toISOString();
        rebuildPriceMap(item);
        return true;
      } catch (error) {
        item.deep_scan_error = error.name === "AbortError" ? "request timeout" : error.message;
        return false;
      }
    }));
    const completed = results.filter(Boolean).length;
    const failed = results.length - completed;
    const elapsed = performance.now() - startedAt;
    if (elapsed < DEEP_SCAN_MIN_MS) await delay(DEEP_SCAN_MIN_MS - elapsed);
    const finishedAt = new Date().toISOString();
    snapshot.deep_scan_updated_at_utc = new Date().toISOString();
    snapshot.deep_scan_duration_seconds = Number(((performance.now() - startedAt) / 1000).toFixed(1));
    snapshot.deep_scan_source_as_of_utc = finishedAt;
    snapshot.deep_scan_completed = completed;
    snapshot.deep_scan_failed = failed;

    render();
    $("#scan-status").textContent = failed ? "DEEP SCAN DEGRADED" : "DEEP SCAN COMPLETE";
    $("#scan-summary").textContent += ` · Deep scan completed in ${snapshot.deep_scan_duration_seconds}s: ${completed}/${snapshot.candidates.length} fresh ${modeConfig[activeMode].historyLabel} histories, ${failed} failed.`;
  } catch (error) { if (!snapshot?.live_quote_complete) renderDataStale(`Deep scan could not verify a complete live quote batch: ${error.message}`); else { $("#scan-status").textContent = "DEEP SCAN FAILED"; $("#scan-summary").textContent = `Deep scan could not complete: ${error.message}`; } }
  finally { button.disabled = false; $("#refresh-button").disabled = false; button.textContent = "Deep scan"; }
}

async function analyze(query) {
  const symbol = query.trim().toUpperCase();
  if (!symbol) return;
  $("#search-status").textContent = `Looking up ${symbol} on Kraken public data…`;
  const result = $("#search-result"); result.hidden = false; result.innerHTML = "<p class=\"muted\">Fetching public ticker data; no order will be placed.</p>";
  const freshness = liveFreshness();
  if (!freshness.ok) {
    result.innerHTML = `<p class="muted">DATA STALE — NO SIGNAL. ${escapeHtml(freshness.reason)}</p>`;
    $("#search-status").textContent = "Search blocked until the quote batch is fresh.";
    return;
  }
  const local = [...(snapshot?.candidates || []), ...(snapshot?.avoids || [])].find(item => String(item.symbol || "").toUpperCase() === symbol);
  if (local) {
    const metrics = local.metrics || {};
    const change = metrics.change_24h_pct == null ? null : Number(metrics.change_24h_pct);
    result.innerHTML = `<h3>${escapeHtml(symbol)} · ${escapeHtml(biasLabel[String(local.bias || "WATCH")] || String(local.bias || "WATCH"))}</h3><p class="muted">${price(metrics.last)} USD · 24h change ${change == null ? "n/a" : change.toFixed(2) + "%"}</p><p class="muted">${escapeHtml(local.explanation?.quick_reason || local.avoid_reason || "Quality screen result")}</p><p class="muted">Snapshot search is monitoring-only; no order will be placed.</p>`;
    $("#search-status").textContent = "Found in the latest hourly snapshot.";
    return;
  }
  try {
    const pairs = await fetchFreshJson("https://api.kraken.com/0/public/AssetPairs");
    const pairKey = buildUsdPairMap(pairs.result)[symbol];
    if (!pairKey) throw new Error("No Kraken USD spot pair found");
    const ticker = await fetchFreshJson(`https://api.kraken.com/0/public/Ticker?pair=${encodeURIComponent(pairKey)}`);
    const row = ticker.result?.[pairKey] || Object.values(ticker.result || {})[0]; if (!row) throw new Error("Ticker unavailable");
    const last = Number(row.c?.[0]); const opening = Number(row.o); const high = Number(row.h?.[1]); const low = Number(row.l?.[1]);
    if (![last, opening, high, low].every(Number.isFinite) || last <= 0 || opening <= 0 || high <= 0 || low <= 0 || last < low || last > high) throw new Error("Kraken returned an invalid USD quote range");
    const change = ((last / opening) - 1) * 100;
    result.innerHTML = `<h3>${escapeHtml(symbol)} · ${change == null ? "NEUTRAL" : change >= 1 ? "BULLISH SETUP" : change <= -1 ? "BEARISH SETUP" : "NEUTRAL"}</h3><p class="muted">${price(last)} USD · 24h change ${change == null ? "n/a" : change.toFixed(2) + "%"}</p><p class="muted">Monitoring only. Verify the market yourself; no order path exists.</p>`;
    $("#search-status").textContent = "Public ticker returned.";
  } catch (error) { result.innerHTML = `<p class="muted">${escapeHtml(error.message)}. Try a Kraken symbol such as BTC or ETH.</p>`; $("#search-status").textContent = "Search unavailable."; }
}

async function boot({manual = false} = {}) {
  if (!modeConfig[activeMode]) { activeMode = "hourly"; }
  $("#deep-scan-button").disabled = false; $("#deep-scan-button").textContent = "Deep scan";
  const button = $("#refresh-button");
  button.disabled = true; button.textContent = "Refreshing…";
  $("#scan-status").textContent = "REFRESHING";
  const previousTimestamp = snapshot?.generated_at_utc;
  snapshot = null;
  renderDataStale("Refreshing all displayed markets from Kraken...");
  try {
    snapshot = await fetchFreshJson(modeConfig[activeMode].file);
    const liveCount = await refreshLiveQuotes();
    if (!snapshot.live_quote_complete || liveCount !== snapshot.live_quote_expected_count) throw new Error(`complete live quote refresh failed (${liveCount}/${snapshot.live_quote_expected_count})`);
    recalculateLiveRanking();
    const freshness = liveFreshness();
    if (!freshness.ok) throw new Error(freshness.reason);
    render();
    const liveTime = snapshot.live_quote_updated_at_utc ? new Date(snapshot.live_quote_updated_at_utc).toLocaleTimeString([], {hour: "numeric", minute: "2-digit"}) : "unavailable";
    const socialTime = snapshot.social_context?.captured_at_utc ? new Date(snapshot.social_context.captured_at_utc).toLocaleString() : "unavailable";
    $("#scan-summary").textContent += ` · Live Kraken quotes updated ${liveTime} (${liveCount}/${snapshot.candidates.length}); market artifact captured ${new Date(snapshot.generated_at_utc).toLocaleString()}; social/news artifact captured ${socialTime}.`;
    if (manual && previousTimestamp && previousTimestamp === snapshot.generated_at_utc) { $("#scan-status").textContent = `LIVE ${modeConfig[activeMode].title}`; }
  }
  catch (error) { snapshot = null; renderDataStale(`Live market refresh failed: ${error.message}`); }
  finally { button.disabled = false; button.textContent = "Quick scan"; }
}
$("#search-button").addEventListener("click", () => analyze($("#coin-search").value));
$("#coin-search").addEventListener("keydown", event => { if (event.key === "Enter") analyze(event.target.value); });
$("#refresh-button").addEventListener("click", () => boot({manual: true}));
$("#deep-scan-button").addEventListener("click", runDeepScan);
document.querySelectorAll(".tab").forEach(tab => tab.addEventListener("click", () => { activeMode = tab.dataset.mode; document.querySelectorAll(".tab").forEach(item => { const selected = item === tab; item.classList.toggle("active", selected); item.setAttribute("aria-selected", String(selected)); }); $("#horizon-label").textContent = modeConfig[activeMode]?.eyebrow || "LONG-TERM HORIZON"; boot(); }));
document.querySelectorAll(".direction-tab").forEach(tab => tab.addEventListener("click", () => { activeDirection = tab.dataset.direction; document.querySelectorAll(".direction-tab").forEach(item => item.classList.toggle("active", item === tab)); if (snapshot) render(); }));
if ("serviceWorker" in navigator) navigator.serviceWorker.register("service-worker.js").catch(() => {});
boot();
