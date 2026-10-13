const $ = selector => document.querySelector(selector);
const escapeHtml = value => String(value ?? "").replace(/[&<>\"]/g, character => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;"}[character]));
const price = value => value == null ? "n/a" : Number(value).toLocaleString(undefined, { maximumSignificantDigits: 8 });
const APP_BUILD_ID = "hype-v2";
const MAX_LIVE_QUOTE_AGE_SECONDS = 120;
const MAX_HYPE_AGE_SECONDS = 7200;
let snapshot = null;
let snapshotsByMode = {};
let refreshFailures = [];
let activeMode = "hourly";
let activeDirection = "all";
const biasLabel = {LONG_RESEARCH: "BULLISH SETUP", SHORT_RESEARCH: "BEARISH SETUP", AVOID: "WATCH ONLY"};
const timeframeLabel = {SHORT_TERM: "DAY TRADING", MEDIUM_LONG_TERM: "WEEKLY TRADING", LONG_TERM: "3+ MONTHS"};
const modeConfig = {hourly: {file: "data/market-opportunities-hourly-latest.json", title: "DAY TRADING", eyebrow: "NEXT HOURLY REVIEW", interval: 60, historyLabel: "hourly"}, daily: {file: "data/market-opportunities-daily-latest.json", title: "WEEKLY TRADING", eyebrow: "NEXT WEEKLY REVIEW", interval: 1440, historyLabel: "daily"}, "long-term": {file: "data/market-opportunities-long-term-latest.json", title: "3+ MONTHS", eyebrow: "NEXT LONG-TERM REVIEW", interval: 1440, historyLabel: "daily"}};
const DEEP_SCAN_MIN_MS = 15000;
const REQUEST_TIMEOUT_MS = 30000;
const REQUEST_RETRY_DELAYS_MS = [300, 1000, 2500];

function freshUrl(url) {
  return `${url}${url.includes("?") ? "&" : "?"}_fresh=${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

function utcAgeSeconds(value) {
  const timestamp = Date.parse(value || "");
  if (!Number.isFinite(timestamp)) return null;
  return (Date.now() - timestamp) / 1000;
}

function renderDataStale(reason) {
  renderSocial(snapshot?.social_context || {});
  $("#scan-status").textContent = "DATA STALE";
  $("#scan-summary").textContent = `${reason} Build ${APP_BUILD_ID}. No setup or price map is actionable until a complete live refresh succeeds.`;
  $("#opportunities").innerHTML = `<div class="panel"><strong>DATA STALE — NO SIGNAL</strong><p class="muted">${escapeHtml(reason)}</p><p class="muted">Required: ${MAX_LIVE_QUOTE_AGE_SECONDS}-second maximum quote age, complete candidate coverage, and compatible fresh range data.</p></div>`;
}

function liveFreshness(targetSnapshot = snapshot) {
  if (!targetSnapshot || !Array.isArray(targetSnapshot.candidates) || !targetSnapshot.candidates.length) return {ok: false, reason: "No market snapshot is loaded."};
  const expected = Number(targetSnapshot.live_quote_expected_count || targetSnapshot.candidates.length);
  const received = Number(targetSnapshot.live_quote_count || 0);
  const missing = targetSnapshot.candidates.filter(item => item.live_quote_status !== "FRESH").map(item => item.symbol).filter(Boolean);
  if (!targetSnapshot.live_quote_complete || received !== expected || missing.length) {
    return {ok: false, reason: `Live Kraken quote refresh incomplete (${received}/${expected}); missing: ${missing.join(", ") || "unknown"}.`};
  }
  const age = utcAgeSeconds(targetSnapshot.live_quote_updated_at_utc);
  if (age == null || age < -5 || age > MAX_LIVE_QUOTE_AGE_SECONDS) {
    return {ok: false, reason: `Live Kraken quote batch is ${age == null ? "undated" : `${Math.max(0, age).toFixed(0)} seconds old`}.`};
  }
  return {ok: true, age};
}

async function fetchFreshJson(url, options = {}) {
  const {timeout = REQUEST_TIMEOUT_MS, retryAttempts = REQUEST_RETRY_DELAYS_MS.length, ...requestOptions} = options;
  let lastError = null;
  for (let attempt = 0; attempt < retryAttempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(freshUrl(url), {cache: "no-store", signal: controller.signal, ...requestOptions});
      if (!response.ok) {
        const error = new Error(`HTTP ${response.status}`);
        error.status = response.status;
        error.retryable = response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500;
        throw error;
      }
      const payload = await response.json();
      if (payload?.error?.length) throw new Error(payload.error.join(", "));
      return payload;
    } catch (error) {
      lastError = error;
      const retryable = error?.retryable !== false && (error?.name === "AbortError" || error?.name === "TypeError" || error?.retryable === true || !error?.status);
      if (!retryable || attempt >= retryAttempts - 1) throw error;
      await delay(REQUEST_RETRY_DELAYS_MS[Math.min(attempt, REQUEST_RETRY_DELAYS_MS.length - 1)]);
    } finally { clearTimeout(timer); }
  }
  throw lastError || new Error("Request failed after retries");
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
  const mapNotice = map?.side === "SHORT_RESEARCH" && item.margin_status !== "verified_enabled" ? `<small class="map-note">BEARISH RESEARCH MAP — MONITORING ONLY; margin permission is not verified.</small>` : "";
  const setup = map ? `<div class="setup"><div><span>Entry zone</span><strong>${price(map.entry_low)} – ${price(map.entry_high)}</strong></div><div><span>Invalidation</span><strong>${price(map.invalidation)}</strong></div><div><span>Target 1</span><strong>${price(map.target_one)}</strong></div><div><span>Target 2</span><strong>${price(map.target_two)}</strong></div>${mapNotice}</div>` : "";
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
  renderSocial(snapshot?.social_context || {});
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
  $("#scan-summary").textContent = `${choices.length} ${directionLabel} ranked by market-only score · ${setupCount} setup${setupCount === 1 ? "" : "s"} cleared the latest screen${selection} · captured ${new Date(snapshot.generated_at_utc).toLocaleString()} · WATCH ONLY cards are monitoring-only.`;
  const artifactAge = utcAgeSeconds(snapshot.generated_at_utc);
  $("#scan-summary").textContent += ` Â· live quotes ${snapshot.live_quote_source || "unknown source"}, ${freshness.age.toFixed(0)}s old (${snapshot.live_quote_count}/${snapshot.live_quote_expected_count}) Â· artifact age ${artifactAge == null ? "unknown" : `${Math.max(0, artifactAge).toFixed(0)}s`} Â· build ${APP_BUILD_ID}.`;
  $("#opportunities").innerHTML = choices.length ? choices.map(card).join("") : `<div class="panel"><strong>No directional setup cleared this hour.</strong><p class="muted">${bearish} bearish candidate${bearish === 1 ? " was" : "s were"} found in the latest scan. All labels are monitoring-only until independently verified.</p></div>`;
}

function renderSocial(social) {
  const items = (social.items || []).slice(0, 20);
  const health = social.source_health || {};
  const degraded = Object.values(health).some(value => ["DEGRADED", "FAILED"].includes(String(value.status).toUpperCase()));
  const captureAge = utcAgeSeconds(social.captured_at_utc);
  const stale = captureAge == null || captureAge < -5 || captureAge > MAX_HYPE_AGE_SECONDS;
  $("#social-status").textContent = stale ? "STALE DATA" : degraded ? "DEGRADED SOURCES" : String(social.status || "NO DATA").replaceAll("_", " ");
  const captured = social.captured_at_utc ? new Date(social.captured_at_utc).toLocaleString() : "capture time unknown";
  const captureAgeLabel = captureAge == null ? "age unknown" : captureAge < 3600 ? `${Math.max(0, Math.floor(captureAge / 60))}m old` : `${(Math.max(0, captureAge) / 3600).toFixed(1)}h old`;
  const attribution = social.attribution || "CoinGecko attribution applies when its data is present.";
  $("#social-summary").textContent = items.length ? `${items.length} CoinGecko trending projects · capture ${captured} (${captureAgeLabel}; stale after 2h). Counts below are matching, dated RSS items; collector target is hourly. ${attribution}` : `No Hype data available · capture ${captured} (${captureAgeLabel}). ${attribution}`;
  $("#social-health").innerHTML = Object.entries(health).map(([name, value]) => `<span>${escapeHtml(name.replaceAll("_", " "))}: <strong>${escapeHtml(value.status || "UNKNOWN")}</strong></span>`).join("");
  const formatAge = seconds => seconds == null || !Number.isFinite(seconds) ? "age unknown" : seconds < 3600 ? `${Math.floor(seconds / 60)}m ago` : seconds < 86400 ? `${(seconds / 3600).toFixed(1)}h ago` : `${(seconds / 86400).toFixed(1)}d ago`;
  const ageAt = timestamp => { const parsed = Date.parse(timestamp || ""); if (!Number.isFinite(parsed)) return "age unknown"; const seconds = (Date.now() - parsed) / 1000; return seconds < -5 ? "age unknown" : formatAge(Math.max(0, seconds)); };
  const newestMentionAt = item => [item.mentions?.google_news?.newest_published_at_utc, item.mentions?.reddit?.newest_published_at_utc].filter(Boolean).sort((left, right) => Date.parse(right) - Date.parse(left))[0] || null;
  const count = (mention, window) => mention?.status === "FRESH" ? String(mention[`relevant_count_${window}`] ?? "unknown") : "unknown";
  const money = value => value == null ? "unknown" : `$${Number(value).toLocaleString(undefined, {maximumSignificantDigits: 8})}`;
  const mention = (source, label) => {
    const data = source || {};
    if (data.status !== "FRESH") return `<div class="mention-block"><strong>${label}</strong><p>${escapeHtml(data.status || "UNKNOWN")} · counts unavailable, not zero.</p></div>`;
    const headlines = (data.headlines || []).map(row => `<li><a href="${escapeHtml(row.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(row.title)}</a><span>${ageAt(row.published_at_utc)} · ${escapeHtml(row.matched_text)} matched</span></li>`).join("");
    return `<div class="mention-block"><strong>${label}</strong><p>${Number(data.relevant_count_24h || 0)} relevant items / 24h · ${Number(data.relevant_count_7d || 0)}/7d · newest ${ageAt(data.newest_published_at_utc)} · capture ${escapeHtml(data.query_at_utc ? new Date(data.query_at_utc).toLocaleString() : "unknown")}</p>${Number(data.undated_matched_item_count || 0) ? `<p>${Number(data.undated_matched_item_count)} matching results excluded because publication time is unknown.</p>` : ""}${headlines ? `<ul>${headlines}</ul>` : "<p>No dated relevant items.</p>"}</div>`;
  };
  const identity = item => {
    const contracts = item.identity?.contracts || [];
    if (!contracts.length) return `<p class="muted">Identity: contract unavailable. No name based market links.</p>`;
    return `<ul class="contract-list">${contracts.map(contract => `<li><strong>${escapeHtml(contract.chain)}</strong><code>${escapeHtml(contract.address)}</code><button type="button" class="copy-address" data-address="${escapeHtml(contract.address)}">Copy</button>${contract.explorer_url ? `<a href="${escapeHtml(contract.explorer_url)}" target="_blank" rel="noopener noreferrer">Explorer</a>` : ""}${contract.dex_url ? `<a href="${escapeHtml(contract.dex_url)}" target="_blank" rel="noopener noreferrer">DEX Screener</a>` : ""}</li>`).join("")}</ul>${contracts.length > 1 ? `<p class="muted">Multiple contract addresses; each chain is listed separately.</p>` : ""}`;
  };
  const pairDetails = (item, requestedPairs = item.dex_pairs || []) => {
    const pairs = [...requestedPairs].sort((left, right) => Number(right.liquidity_usd != null) - Number(left.liquidity_usd != null) || Number(right.liquidity_usd || 0) - Number(left.liquidity_usd || 0));
    if (!pairs.length) return `<p class="muted">DEX pairs unavailable; pair age and liquidity unknown.</p>`;
    return `<div class="pair-list">${pairs.map((pair, index) => {
      const tx24 = pair.buys_sells_by_period?.h24 || {};
      const v24 = pair.volume_by_period?.h24;
      const changes = pair.price_change_by_period || {};
      const primary = pair.is_primary === true || (pair.is_primary == null && index === 0 && pair.liquidity_usd != null);
      return `<div class="pair-row"><strong>${escapeHtml(pair.dex_id || "DEX")} ${primary ? "· Primary pair (highest known liquidity)" : ""}</strong>${pair.pair_url ? `<a href="${escapeHtml(pair.pair_url)}" target="_blank" rel="noopener noreferrer">Open pair</a>` : ""}<p>Pair age ${ageAt(pair.pair_created_at_utc)} · liquidity ${money(pair.liquidity_usd)} · FDV ${money(pair.fdv_usd)} · 24h volume ${money(v24)} · 24h buys ${tx24.buys ?? "unknown"} / sells ${tx24.sells ?? "unknown"} · 24h move ${changes.h24 == null ? "unknown" : `${changes.h24}%`} · capture ${escapeHtml(pair.captured_at_utc ? new Date(pair.captured_at_utc).toLocaleString() : "unknown")}</p></div>`;
    }).join("")}</div>`;
  };
  $("#social-items").innerHTML = items.length ? items.map(item => {
    const momentum = item.momentum || {};
    const trending = item.trending || {};
    const fomo = item.fomo_watch || {};
    const observations = (fomo.observations || []).map(row => `<li>${escapeHtml(row.kind.replaceAll("_", " "))} · ${escapeHtml(row.source)} · ${escapeHtml(JSON.stringify(Object.fromEntries(Object.entries(row).filter(([key]) => !["kind", "source"].includes(key)))))}</li>`).join("");
    const headlineTop = [item.mentions?.google_news, item.mentions?.reddit].flatMap(value => value?.headlines || []).sort((a, b) => Date.parse(b.published_at_utc) - Date.parse(a.published_at_utc)).slice(0, 3);
    const multiContract = (item.identity?.contracts || []).length > 1;
    const pairContent = multiContract ? `<label class="chain-picker">Choose a chain before loading address matched pairs<select class="pair-chain" data-coin-id="${escapeHtml(item.coingecko_id)}"><option value="">Choose chain</option>${item.identity.contracts.map(contract => `<option value="${escapeHtml(contract.chain)}">${escapeHtml(contract.chain)}</option>`).join("")}</select></label><div class="pair-results" data-coin-id="${escapeHtml(item.coingecko_id)}"><p class="muted">Choose a chain to show address matched pairs.</p></div>` : pairDetails(item);
    return `<details class="hype-card"><summary><span><strong>${escapeHtml(item.name)} <small>${escapeHtml(item.symbol)}</small></strong><span>CoinGecko trending #${trending.rank ?? "?"} · ${escapeHtml(momentum.state || "INSUFFICIENT_HISTORY").replaceAll("_", " ")}</span></span><span class="summary-meta">${count(item.mentions?.google_news, "24h")} News / 24h · ${count(item.mentions?.reddit, "24h")} Reddit / 24h<br>newest ${ageAt(newestMentionAt(item))}</span></summary><div class="hype-body"><p>CoinGecko rank #${trending.rank ?? "unknown"} · previous ${trending.previous_rank ?? "unknown"} · change ${trending.change == null ? "unknown" : `${trending.change > 0 ? "+" : ""}${trending.change}`} · rolling 24h · ${escapeHtml(trending.state || "INSUFFICIENT_HISTORY").replaceAll("_", " ")}${momentum.comparison_at_utc ? ` since ${new Date(momentum.comparison_at_utc).toLocaleString()}` : " · insufficient history"}</p><div class="metrics"><div class="metric"><span>CoinGecko price</span><strong>${money(item.market?.price_usd)}</strong></div><div class="metric"><span>Market cap</span><strong>${money(item.market?.market_cap_usd)}</strong></div><div class="metric"><span>24h volume</span><strong>${money(item.market?.volume_24h_usd)}</strong></div><div class="metric"><span>Volume / market cap · 24h</span><strong>${item.market?.volume_market_cap_ratio == null ? "unknown" : `${(item.market.volume_market_cap_ratio * 100).toFixed(2)}%`} · captured ${escapeHtml(item.market?.captured_at_utc ? new Date(item.market.captured_at_utc).toLocaleString() : "unknown")}</strong></div><div class="metric"><span>CoinGecko 24h change</span><strong>${item.market?.change_24h_pct == null ? "unknown" : `${item.market.change_24h_pct}%`}</strong></div><div class="metric"><span>Volume change vs prior capture</span><strong>${momentum.volume_change_pct == null ? "insufficient history" : `${momentum.volume_change_pct.toFixed(2)}%`}</strong></div><div class="metric"><span>Matching mention changes vs prior capture · 24h / 7d</span><strong>${escapeHtml(JSON.stringify(momentum.mention_change_by_source || {}))}</strong></div></div><h3>Chain and contract</h3>${identity(item)}<h3>Recent matching headlines</h3>${headlineTop.length ? `<ul class="headlines">${headlineTop.map(row => `<li><a href="${escapeHtml(row.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(row.title)}</a><span>${ageAt(row.published_at_utc)}</span></li>`).join("")}</ul>` : `<p class="muted">No dated, relevant headline links.</p>`}<div class="mention-grid">${mention(item.mentions?.google_news, "Google News")}${mention(item.mentions?.reddit, "Reddit sitewide")}</div><h3>Address matched DEX pairs</h3>${pairContent}<h3>FOMO watch · observations only</h3><p class="muted">${escapeHtml(fomo.disclaimer || "Unknown data stays unknown; observations do not affect score or direction.")}</p>${observations ? `<ul>${observations}</ul>` : `<p class="muted">${escapeHtml(fomo.status || "UNKNOWN").replaceAll("_", " ")}; no observation recorded.</p>`}</div></details>`;
  }).join("") : `<p class="muted">Social sources are unavailable or still refreshing.</p>`;
  document.querySelectorAll(".copy-address").forEach(button => button.addEventListener("click", async () => { try { await navigator.clipboard.writeText(button.dataset.address); button.textContent = "Copied"; } catch { button.textContent = "Copy unavailable"; } }));
  document.querySelectorAll(".pair-chain").forEach(select => select.addEventListener("change", () => {
    const item = items.find(row => row.coingecko_id === select.dataset.coinId);
    const target = document.querySelector(`.pair-results[data-coin-id="${CSS.escape(select.dataset.coinId)}"]`);
    if (!item || !target) return;
    const pairs = select.value ? (item.dex_pairs || []).filter(pair => pair.coingecko_platform === select.value) : [];
    target.innerHTML = select.value ? pairDetails(item, pairs) : `<p class="muted">Choose a chain to show address matched pairs.</p>`;
  }));
}

function renderLongTerm() {
  return boot();
}

async function fetchLiveQuoteBatch(targetSnapshots) {
  const pairs = await fetchFreshJson("https://api.kraken.com/0/public/AssetPairs");
  const pairForSymbol = buildUsdPairMap(pairs.result);
  const requested = [...new Set(targetSnapshots.flatMap(targetSnapshot => targetSnapshot.candidates.map(item => pairForSymbol[String(item.symbol || "").toUpperCase()]).filter(Boolean)))];
  if (!requested.length) throw new Error("No Kraken USD spot pairs found for the candidate set");
  const ticker = await fetchFreshJson(`https://api.kraken.com/0/public/Ticker?pair=${encodeURIComponent(requested.join(","))}`);
  return {pairForSymbol, ticker, refreshedAt: new Date().toISOString()};
}

async function refreshLiveQuotes(targetSnapshot = snapshot, marketData = null) {
  if (!targetSnapshot?.candidates?.length) return 0;
  const expected = targetSnapshot.candidates.length;
  const refreshStartedAt = marketData?.refreshedAt || new Date().toISOString();
  targetSnapshot.live_quote_expected_count = expected;
  targetSnapshot.live_quote_count = 0;
  targetSnapshot.live_quote_complete = false;
  targetSnapshot.live_quote_source = "Kraken public Ticker; cache-busted no-store request; up to 3 attempts";
  targetSnapshot.live_quote_started_at_utc = refreshStartedAt;
  targetSnapshot.live_quote_failed_symbols = [];
  targetSnapshot.candidates.forEach(item => { item.live_quote_status = "PENDING"; });
  const quoteData = marketData || await fetchLiveQuoteBatch([targetSnapshot]);
  const pairForSymbol = quoteData.pairForSymbol;
  const ticker = quoteData.ticker;
  let updated = 0;
  const failed = [];
  for (const item of targetSnapshot.candidates) {
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
  targetSnapshot.live_quote_updated_at_utc = refreshedAt;
  targetSnapshot.live_quote_count = updated;
  targetSnapshot.live_quote_failed_symbols = failed;
  targetSnapshot.live_quote_complete = updated === expected && failed.length === 0;
  targetSnapshot.candidates.forEach(item => { if (item.live_quote_status === "FRESH") item.live_quote_updated_at_utc = refreshedAt; });
  return updated;
}

function rebuildPriceMap(item) {
  const metrics = item.metrics || {};
  const last = Number(metrics.last); const high = Number(metrics.high_24h); const low = Number(metrics.low_24h);
  if (![last, high, low].every(value => Number.isFinite(value) && value > 0) || high < low || last < low || last > high) { item.price_map = null; item.price_map_status = "INVALID_FRESH_RANGE"; return; }
  const range = Math.max(high - low, last * 0.005);
  if (item.bias === "LONG_RESEARCH") {
    item.price_map = {side: "LONG_RESEARCH", entry_low: Math.max(low, last - range * 0.35), entry_high: last, invalidation: Math.max(0, low - range * 0.25), target_one: last + range * 0.5, target_two: last + range, method: "24-hour range pullback and extension map"};
    item.price_map_status = "FRESH";
  } else if (item.bias === "SHORT_RESEARCH") {
    item.price_map = {side: "SHORT_RESEARCH", entry_low: last, entry_high: last + range * 0.35, invalidation: high + range * 0.25, target_one: Math.max(0, last - range * 0.5), target_two: Math.max(0, last - range), method: "fresh Kraken 24-hour range rejection and extension map"};
    item.price_map_status = item.margin_status === "verified_enabled" ? "FRESH" : "FRESH_RESEARCH_ONLY";
  } else {
    item.price_map = null;
    item.price_map_status = "NONE";
  }
}

function recalculateLiveRanking(targetSnapshot = snapshot) {
  if (!targetSnapshot?.candidates?.length) return;
  const clamp = value => Math.max(-1, Math.min(1, value));
  for (const item of targetSnapshot.candidates) {
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
    const score = Number(marketScore.toFixed(2));
    item.opportunity_score = score;
    item.confidence_band = score >= 70 ? "HIGH" : score >= 45 ? "MODERATE" : "LOW";
    item.bias = marketDirection >= 0.25 ? "LONG_RESEARCH" : marketDirection <= -0.25 ? "SHORT_RESEARCH" : "AVOID";
    item.score_breakdown = {...(item.score_breakdown || {}), score, band: item.confidence_band, bias: item.bias, market_score: score, market_direction: Number(marketDirection.toFixed(4))};
    item.explanation = {...(item.explanation || {}), directional_change_24h_pct: change, quick_reason: item.bias === "LONG_RESEARCH" ? "Fresh Kraken quote passed the bullish research threshold." : item.bias === "SHORT_RESEARCH" ? "Fresh Kraken quote passed the bearish research threshold; short execution remains permission-gated." : "Fresh Kraken quote did not clear the directional research threshold."};
    rebuildPriceMap(item);
  }
  targetSnapshot.candidates.sort((a, b) => Number(b.opportunity_score || 0) - Number(a.opportunity_score || 0) || String(a.symbol || "").localeCompare(String(b.symbol || "")));
  targetSnapshot.candidates.forEach((item, index) => { item.rank = index + 1; });
  targetSnapshot.opportunities = targetSnapshot.candidates.filter(item => item.bias !== "AVOID");
  targetSnapshot.avoids = targetSnapshot.candidates.filter(item => item.bias === "AVOID");
}

function cloneJson(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

async function refreshAllSnapshots() {
  const results = await Promise.all(Object.entries(modeConfig).map(async ([mode, config]) => {
    try {
      return {mode, snapshot: await fetchFreshJson(config.file)};
    } catch (error) {
      return {mode, error: error.message || String(error)};
    }
  }));
  const next = {...snapshotsByMode};
  const failures = [];
  for (const result of results) {
    if (result.snapshot) next[result.mode] = result.snapshot;
    else failures.push(`${modeConfig[result.mode].title}: artifact refresh failed after 3 attempts (${result.error})`);
  }
  if (!next[activeMode]) throw new Error(failures.join(" ") || "No schedule snapshot is available.");
  let latestSocial = null;
  try { latestSocial = await fetchFreshJson("data/social-context-v2-latest.json"); }
  catch { latestSocial = Object.values(next).map(item => item.social_context).filter(item => item?.captured_at_utc).sort((a, b) => Date.parse(b.captured_at_utc) - Date.parse(a.captured_at_utc))[0] || null; }
  if (latestSocial) Object.values(next).forEach(item => { item.social_context = cloneJson(latestSocial); item.social_context_refresh_mode = "latest available shared collector snapshot"; });
  snapshotsByMode = next;
  snapshot = snapshotsByMode[activeMode];
  refreshFailures = failures;
  return failures;
}

async function refreshAllLiveQuotes() {
  const targets = Object.values(snapshotsByMode);
  const marketData = await fetchLiveQuoteBatch(targets);
  const results = await Promise.all(Object.entries(snapshotsByMode).map(async ([mode, targetSnapshot]) => {
    try {
      const count = await refreshLiveQuotes(targetSnapshot, marketData);
      if (!targetSnapshot.live_quote_complete || count !== targetSnapshot.live_quote_expected_count) throw new Error(`${count}/${targetSnapshot.live_quote_expected_count} complete`);
      recalculateLiveRanking(targetSnapshot);
      return {mode};
    } catch (error) {
      return {mode, error: error.message || String(error)};
    }
  }));
  const failures = results.filter(result => result.error).map(result => `${modeConfig[result.mode].title}: live quote refresh failed after 3 attempts (${result.error})`);
  refreshFailures = [...refreshFailures, ...failures];
  snapshot = snapshotsByMode[activeMode];
  return failures;
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function run() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({length: Math.min(limit, items.length)}, run));
  return results;
}

async function runDeepScanLegacy() {
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

async function runDeepScan() {
  if (!snapshot?.candidates?.length) return;
  const button = $("#deep-scan-button");
  button.disabled = true; $("#refresh-button").disabled = true; button.textContent = "Scanning all horizons…"; $("#scan-status").textContent = "DEEP SCANNING";
  const startedAt = performance.now();
  try {
    await refreshAllSnapshots();
    await refreshAllLiveQuotes();
    if (!liveFreshness(snapshot).ok) throw new Error(liveFreshness(snapshot).reason);
    const pairs = await fetchFreshJson("https://api.kraken.com/0/public/AssetPairs");
    const pairForSymbol = buildUsdPairMap(pairs.result);
    const horizonResults = await Promise.all(Object.entries(snapshotsByMode).map(async ([mode, targetSnapshot]) => {
      const results = await mapWithConcurrency(targetSnapshot.candidates, 6, async item => {
        const pair = encodeURIComponent(pairForSymbol[String(item.symbol || "").toUpperCase()] || item.pair_key || item.symbol);
        try {
          const result = await fetchFreshJson(`https://api.kraken.com/0/public/OHLC?pair=${pair}&interval=${modeConfig[mode].interval}`);
          const rows = Object.values(result.result || {}).find(value => Array.isArray(value)) || [];
          const recent = rows.slice(mode === "hourly" ? -24 : -90);
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
          item.deep_scan_error = error.name === "AbortError" ? "request timeout after 3 attempts" : error.message;
          return false;
        }
      });
      const completed = results.filter(Boolean).length;
      return {mode, completed, total: results.length, failed: results.length - completed};
    }));
    const completed = horizonResults.reduce((sum, item) => sum + item.completed, 0);
    const total = horizonResults.reduce((sum, item) => sum + item.total, 0);
    const failed = horizonResults.reduce((sum, item) => sum + item.failed, 0);
    const elapsed = performance.now() - startedAt;
    if (elapsed < DEEP_SCAN_MIN_MS) await delay(DEEP_SCAN_MIN_MS - elapsed);
    const finishedAt = new Date().toISOString();
    Object.values(snapshotsByMode).forEach(targetSnapshot => { targetSnapshot.deep_scan_updated_at_utc = new Date().toISOString(); targetSnapshot.deep_scan_duration_seconds = Number(((performance.now() - startedAt) / 1000).toFixed(1)); targetSnapshot.deep_scan_source_as_of_utc = finishedAt; targetSnapshot.deep_scan_completed = completed; targetSnapshot.deep_scan_failed = failed; });
    snapshot = snapshotsByMode[activeMode];
    render();
    $("#scan-status").textContent = failed ? "DEEP SCAN DEGRADED" : "DEEP SCAN COMPLETE";
    $("#scan-summary").textContent += ` · Deep scan completed in ${snapshot.deep_scan_duration_seconds}s across all schedules: ${completed}/${total} fresh histories, ${failed} failed.`;
  } catch (error) {
    if (!snapshot?.live_quote_complete) renderDataStale(`Deep scan could not verify a complete live quote batch: ${error.message}`);
    else { $("#scan-status").textContent = "DEEP SCAN FAILED"; $("#scan-summary").textContent = `Deep scan could not complete: ${error.message}`; }
  } finally { button.disabled = false; $("#refresh-button").disabled = false; button.textContent = "Deep scan"; }
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

async function bootLegacy({manual = false} = {}) {
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
  catch (error) { renderDataStale(`Live market refresh failed: ${error.message}`); }
  finally { button.disabled = false; button.textContent = "Quick scan"; }
}
async function boot({manual = false} = {}) {
  if (!modeConfig[activeMode]) activeMode = "hourly";
  $("#deep-scan-button").disabled = false; $("#deep-scan-button").textContent = "Deep scan";
  const button = $("#refresh-button");
  button.disabled = true; button.textContent = "Refreshing all…"; $("#scan-status").textContent = "REFRESHING ALL SCHEDULES";
  const previousTimestamp = snapshot?.generated_at_utc;
  renderDataStale("Refreshing all schedules, prices, and the latest available social/news context…");
  try {
    await refreshAllSnapshots();
    await refreshAllLiveQuotes();
    snapshot = snapshotsByMode[activeMode];
    const freshness = liveFreshness(snapshot);
    if (!freshness.ok) throw new Error(freshness.reason);
    render();
    const socialTime = snapshot.social_context?.captured_at_utc ? new Date(snapshot.social_context.captured_at_utc).toLocaleString() : "unavailable";
    const freshModes = Object.values(snapshotsByMode).filter(item => liveFreshness(item).ok).length;
    $("#scan-summary").textContent += ` · All schedules refreshed (${freshModes}/${Object.keys(modeConfig).length}); social/news context captured ${socialTime}; up to 3 attempts per source.`;
    if (refreshFailures.length) $("#scan-summary").textContent += ` · REFRESH DEGRADED: ${refreshFailures.join(" | ")}`;
    if (manual && previousTimestamp && previousTimestamp === snapshot.generated_at_utc) $("#scan-status").textContent = `LIVE ${modeConfig[activeMode].title}`;
  } catch (error) {
    snapshot = snapshotsByMode[activeMode] || null;
    renderDataStale(`Full refresh failed after retries: ${error.message}`);
  } finally { button.disabled = false; button.textContent = "Quick scan"; }
}

$("#search-button").addEventListener("click", () => analyze($("#coin-search").value));
$("#coin-search").addEventListener("keydown", event => { if (event.key === "Enter") analyze(event.target.value); });
$("#refresh-button").addEventListener("click", () => boot({manual: true}));
$("#deep-scan-button").addEventListener("click", runDeepScan);
document.querySelectorAll(".tab").forEach(tab => tab.addEventListener("click", () => { activeMode = tab.dataset.mode; document.querySelectorAll(".tab").forEach(item => { const selected = item === tab; item.classList.toggle("active", selected); item.setAttribute("aria-selected", String(selected)); }); $("#horizon-label").textContent = modeConfig[activeMode]?.eyebrow || "LONG-TERM HORIZON"; if (snapshotsByMode[activeMode] && liveFreshness(snapshotsByMode[activeMode]).ok) { snapshot = snapshotsByMode[activeMode]; render(); } else { boot(); } }));
document.querySelectorAll(".direction-tab").forEach(tab => tab.addEventListener("click", () => { activeDirection = tab.dataset.direction; document.querySelectorAll(".direction-tab").forEach(item => item.classList.toggle("active", item === tab)); if (snapshot) render(); }));
document.querySelectorAll(".view-tab").forEach(tab => tab.addEventListener("click", () => {
  document.querySelectorAll(".view-tab").forEach(item => { const active = item === tab; item.classList.toggle("active", active); item.setAttribute("aria-selected", String(active)); });
  document.querySelectorAll(".view-pane").forEach(pane => { pane.hidden = pane.id !== tab.dataset.view; });
}));
$("#paper-link").addEventListener("click", () => {
  const popup = window.open("about:blank", "_blank");
  let address = "";
  try {
    address = localStorage.getItem("paperDashboardAddress") || "";
    if (!address) {
      address = (window.prompt("Paste the private Paper Trading dashboard address (URL only). Never paste a token or password.") || "").trim();
      if (!address) { popup?.close(); return; }
      let parsedAddress;
      try { parsedAddress = new URL(address); } catch { parsedAddress = null; }
      const credentialInAddress = parsedAddress && (parsedAddress.username || parsedAddress.password || /token|secret|password|auth|credential|session|api.?key/i.test(`${parsedAddress.search}${parsedAddress.hash}`));
      if (!parsedAddress || !["http:", "https:"].includes(parsedAddress.protocol) || credentialInAddress) { popup?.close(); window.alert("Enter the dashboard address only, with no embedded token, password, or credential."); return; }
      localStorage.setItem("paperDashboardAddress", address);
    } else {
      let parsedAddress;
      try { parsedAddress = new URL(address); } catch { parsedAddress = null; }
      const credentialInAddress = parsedAddress && (parsedAddress.username || parsedAddress.password || /token|secret|password|auth|credential|session|api.?key/i.test(`${parsedAddress.search}${parsedAddress.hash}`));
      if (!parsedAddress || !["http:", "https:"].includes(parsedAddress.protocol) || credentialInAddress) { popup?.close(); window.alert("Saved dashboard address is invalid. Clear it and enter the address only."); return; }
    }
  } catch {
    popup?.close();
    window.alert("This browser could not save the dashboard address. Check device storage settings and try again.");
    return;
  }
  if (popup) { popup.opener = null; popup.location.replace(address); }
  else window.alert("Allow popups for this site, then tap Paper Trading again.");
});
if ("serviceWorker" in navigator) navigator.serviceWorker.register("service-worker.js").catch(() => {});
boot();
