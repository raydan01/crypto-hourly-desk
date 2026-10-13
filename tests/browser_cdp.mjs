import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EDGE_CANDIDATES = [
  path.join(process.env.PROGRAMFILES || "C:\\Program Files", "Microsoft", "Edge", "Application", "msedge.exe"),
  path.join(process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)", "Microsoft", "Edge", "Application", "msedge.exe"),
  path.join(process.env.LOCALAPPDATA || "", "Microsoft", "Edge", "Application", "msedge.exe"),
];
const EDGE = EDGE_CANDIDATES.find(candidate => candidate && fs.existsSync(candidate));
assert.ok(EDGE, `Microsoft Edge not found at known install paths: ${EDGE_CANDIDATES.join(", ")}`);
assert.equal(typeof WebSocket, "function", "This script requires Node.js with the built-in WebSocket client");

function stopEdgeProcessesForProfile(profile) {
  if (process.platform !== "win32") return true;
  const escapedProfile = profile.replaceAll("'", "''");
  const script = `$profile = '${escapedProfile}'; Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'msedge.exe' -and $_.CommandLine -like ('*' + $profile + '*') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`;
  try {
    execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { stdio: "pipe" });
    return true;
  } catch (error) {
    if (/Access denied|0x80041003/i.test(String(error.stderr || error.message))) return false;
    throw error;
  }
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

function mime(file) {
  return ({ ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml" })[path.extname(file)] || "application/octet-stream";
}

const uiFixtureData = JSON.parse(fs.readFileSync(path.join(ROOT, "tests", "fixtures", "social-context-v2-ui.json"), "utf8"));
uiFixtureData.captured_at_utc = new Date().toISOString();
uiFixtureData.source_health.reddit = { status: "DEGRADED", error_class: "RATE_LIMITED" };
const recordedLiveFixture = fs.readFileSync(path.join(ROOT, "tests", "fixtures", "recorded", "live-collector-output-f494d74.json"));
const secondRecordedLiveData = JSON.parse(fs.readFileSync(path.join(ROOT, "tests", "fixtures", "recorded", "live-collector-output-5f40129-second-capture.json"), "utf8"));
const secondRecordedLiveFixture = Buffer.from(JSON.stringify(secondRecordedLiveData));
const strkDedupeData = structuredClone(secondRecordedLiveData);
const strkDedupeItem = strkDedupeData.items.find(item => item.symbol.toUpperCase() === "STRK");
const strkOriginalFlags = strkDedupeItem.fomo_watch.observations.filter(row => row.kind !== "SELLING_PRESSURE");
strkDedupeItem.fomo_watch.observations.push(...strkOriginalFlags.flatMap(row => Array.from({ length: 2 }, () => ({...row}))));
const strkDedupeFixture = Buffer.from(JSON.stringify(strkDedupeData));
const dexCases = [
  ["failed", "FAILED", "HTTPError", "DEX Screener lookup failed (HTTPError); pairs unknown"],
  ["empty", "FRESH", null, "No DEX pairs found for this address"],
  ["unsupported", "UNSUPPORTED", null, "DEX lookup not supported for this chain"],
  ["not-queried", "NOT_QUERIED", null, "DEX not checked this capture"],
];
for (const [id, status, errorClass] of dexCases) {
  const item = structuredClone(uiFixtureData.items[0]);
  item.coingecko_id = id;
  item.name = id;
  item.dex_pairs = [];
  item.identity.contracts = [{ ...item.identity.contracts[0], dex_status: status, dex_error_class: errorClass }];
  uiFixtureData.items.push(item);
}
const pudgy = structuredClone(uiFixtureData.items[0]);
pudgy.coingecko_id = "pudgy-penguins";
pudgy.name = "Pudgy Penguins";
pudgy.dex_pairs = [];
pudgy.identity.contracts = [
  { chain: "abstract", address: "0x1111111111111111111111111111111111111111", dex_status: "UNSUPPORTED" },
  { chain: "ethereum", address: "0x2222222222222222222222222222222222222222", dex_status: "FRESH" },
];
uiFixtureData.items.push(pudgy);
const uiFixture = Buffer.from(JSON.stringify(uiFixtureData));
const identityFailureFixtureData = structuredClone(uiFixtureData);
identityFailureFixtureData.items[0].identity = { status: "LOOKUP_FAILED", contracts: [], warning: "Contract lookup failed this capture (CoinGecko limit). Retry next hour" };
const identityFailureFixture = Buffer.from(JSON.stringify(identityFailureFixtureData));
let successfulTradingArtifactLoads = 0;
let failedHourlyArtifactRequests = 0;
let hourlyArtifactRequests = 0;
let failedDailyArtifactRequests = 0;
let dailyArtifactRequests = 0;
const server = http.createServer((request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, "http://127.0.0.1").pathname);
  const scenario = new URL(request.headers.referer || "http://127.0.0.1/").searchParams.get("testScenario") || /(?:^|;\s*)testScenario=([^;]+)/.exec(request.headers.cookie || "")?.[1];
  if (pathname === "/") { response.writeHead(302, { location: "/index.html" }).end(); return; }
  if (pathname === "/data/social-context-v2-latest.json") {
    if (scenario === "hype-missing") { response.writeHead(404).end("missing Hype fixture"); return; }
    response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    response.end(scenario === "live-ui" ? recordedLiveFixture : scenario === "live-ui-second" ? secondRecordedLiveFixture : scenario === "live-ui-strk-dedupe" ? strkDedupeFixture : scenario === "identity-failure" ? identityFailureFixture : uiFixture);
    return;
  }
  if (scenario === "trading-hangs" && pathname === "/data/market-opportunities-hourly-latest.json") return;
  if (scenario === "trading-failure" && pathname === "/data/market-opportunities-hourly-latest.json") {
    hourlyArtifactRequests += 1;
    if (hourlyArtifactRequests > 1) {
      failedHourlyArtifactRequests += 1;
      response.writeHead(404).end("missing hourly fixture");
      return;
    }
  }
  if (scenario === "deep-artifact-failure" && pathname === "/data/market-opportunities-daily-latest.json") {
    dailyArtifactRequests += 1;
    if (dailyArtifactRequests > 1) {
      failedDailyArtifactRequests += 1;
      response.writeHead(404).end("missing daily fixture");
      return;
    }
  }
  if ((scenario === "cold-start-quick" || scenario === "cold-start-deep") && pathname === "/data/market-opportunities-daily-latest.json") {
    failedDailyArtifactRequests += 1;
    response.writeHead(404).end("missing daily fixture from cold start");
    return;
  }
  if (scenario === "cold-start-active-quick" && pathname === "/data/market-opportunities-hourly-latest.json") {
    response.writeHead(404).end("missing active hourly fixture from cold start");
    return;
  }
  const target = path.resolve(ROOT, `.${pathname}`);
  if (target !== ROOT && !target.startsWith(ROOT + path.sep)) {
    response.writeHead(403).end("forbidden");
    return;
  }
  const pageScenario = pathname === "/index.html" ? new URL(request.url, "http://127.0.0.1").searchParams.get("testScenario") : null;
  if (pageScenario) response.setHeader("set-cookie", `testScenario=${pageScenario}; Path=/`);
  if (pathname.startsWith("/mock-kraken/0/public/")) {
    const snapshots = ["hourly", "daily", "long-term"].map(mode => JSON.parse(fs.readFileSync(path.join(ROOT, "data", `market-opportunities-${mode}-latest.json`), "utf8")));
    const symbols = [...new Set(snapshots.flatMap(snapshot => snapshot.candidates.map(item => String(item.symbol || "").toUpperCase())).filter(Boolean))];
    const endpoint = pathname.split("/").pop();
    const payload = endpoint === "AssetPairs"
      ? {result: Object.fromEntries(symbols.map(symbol => [`${symbol}USD`, {status: "online", wsname: `${symbol}/USD`}]))}
      : endpoint === "OHLC"
      ? {result: {XXBTZUSD: [[1, "100", "105", "95", "101", "100", "200", 50], [2, "101", "106", "96", "102", "100", "200", 50], [3, "102", "107", "97", "103", "100", "200", 50]], last: 3}}
      : {result: Object.fromEntries(symbols.map(symbol => [`${symbol}USD`, {c: ["100"], b: ["99.99"], a: ["100.01"], o: "99", h: ["105", "105"], l: ["95", "95"], v: ["100", "100000"]}]))};
    response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }).end(JSON.stringify(payload));
    return;
  }
  fs.readFile(target, (error, content) => {
    if (error) { response.writeHead(404).end("not found"); return; }
    if (pathname.startsWith("/data/market-opportunities-")) successfulTradingArtifactLoads += 1;
    if (pathname === "/app.js") content = Buffer.from(content.toString("utf8").replaceAll("https://api.kraken.com/0/public", `http://127.0.0.1:${sitePort}/mock-kraken/0/public`));
    response.writeHead(200, { "content-type": mime(target), "cache-control": "no-store" });
    response.end(content);
  });
});
await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
const sitePort = server.address().port;
const debugPort = await freePort();
const tempRoot = path.join(ROOT, ".test-tmp");
fs.mkdirSync(tempRoot, { recursive: true });
const profile = fs.mkdtempSync(path.join(tempRoot, "market-attention-edge-"));
const edgeArgs = [
  "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-extensions", "--no-first-run", "--no-default-browser-check",
  "--no-proxy-server", "--remote-allow-origins=*", `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`,
  "about:blank",
];
const simulateLauncherHandoff = process.platform === "win32" && process.env.CDP_TEST_LAUNCHER_HANDOFF === "1";
const edge = simulateLauncherHandoff
  ? spawn("cmd.exe", ["/d", "/c", "start", "", EDGE, ...edgeArgs], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true })
  : spawn(EDGE, edgeArgs, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
let edgeStderr = "";
edge.stderr.setEncoding("utf8").on("data", chunk => { edgeStderr += chunk; });
let ws;
let shutdownBrowser;
let runError = null;
const cleanupErrors = [];
try {
  let version;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/version`);
      if (response.ok) { version = await response.json(); break; }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(version, `Edge CDP did not start within 15 s (launcher exit code ${edge.exitCode}, stderr: ${edgeStderr})`);
  const launcherExitedBeforeCdp = edge.exitCode !== null;
  const exceptions = [];
  let nextId = 0;
  let pageNextId = 0;
  const innerPending = new Map();
  let send;
  async function connectDebugger(url) {
    ws = new WebSocket(url);
    await new Promise((resolve, reject) => { ws.addEventListener("open", resolve, { once: true }); ws.addEventListener("error", reject, { once: true }); });
    const pending = new Map();
    ws.addEventListener("message", event => {
      const message = JSON.parse(event.data);
      if (process.env.CDP_DEBUG === "1") console.log("CDP", JSON.stringify(message));
      if (message.method === "Target.receivedMessageFromTarget") {
        const inner = JSON.parse(message.params.message);
        if (inner.method === "Runtime.exceptionThrown") exceptions.push(inner.params.exceptionDetails.text || "page exception");
        if (inner.id && innerPending.has(inner.id)) {
          const { resolve, reject } = innerPending.get(inner.id);
          innerPending.delete(inner.id);
          if (inner.error) reject(new Error(inner.error.message)); else resolve(inner.result);
        }
      }
      if (message.id && pending.has(message.id)) {
        const { resolve, reject } = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) reject(new Error(message.error.message)); else resolve(message.result);
      }
    });
    return (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 7000);
      pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }
  send = await connectDebugger(version.webSocketDebuggerUrl);
  shutdownBrowser = () => send("Browser.close");
  const { targetId } = await send("Target.createTarget", { url: `http://127.0.0.1:${sitePort}/index.html?testScenario=trading-failure` });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: false });
  await send("Target.activateTarget", { targetId });
  const pageSend = (method, params = {}) => new Promise(async (resolve, reject) => {
    const id = ++pageNextId;
    const timer = setTimeout(() => { innerPending.delete(id); reject(new Error(`CDP page timeout: ${method}`)); }, 7000);
    innerPending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
    try { await send("Target.sendMessageToTarget", { sessionId, message: JSON.stringify({ id, method, params }) }); }
    catch (error) { clearTimeout(timer); innerPending.delete(id); reject(error); }
  });
  await new Promise(resolve => setTimeout(resolve, 1000));
  await pageSend("Runtime.enable");
  await pageSend("Network.enable");
  await pageSend("Network.setBlockedURLs", { urls: ["https://api.coingecko.com/*", "https://news.google.com/*", "https://www.reddit.com/*", "https://api.dexscreener.com/*"] });
  await pageSend("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  const evaluate = async expression => {
    const result = await pageSend("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
  };
  const loaded = Date.now() + 10000;
  let initial;
  while (Date.now() < loaded) {
    initial = await evaluate(`({ready: document.readyState, cards: document.querySelectorAll("#social-items .hype-card").length, status: document.querySelector("#social-status")?.textContent, width: document.documentElement.scrollWidth})`);
    if (initial.cards > 0) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(initial.cards, 6, JSON.stringify(initial));
  const redditBadge = await evaluate(`document.querySelector("#social-health").innerText`);
  assert.ok(redditBadge.includes("reddit: rate-limited"), redditBadge);
  assert.notEqual(initial.status, "STALE DATA", JSON.stringify(initial));
  assert.ok(initial.width <= 390, JSON.stringify(initial));
  const readyToRefresh = Date.now() + 10000;
  while (Date.now() < readyToRefresh && await evaluate(`document.querySelector("#refresh-button")?.disabled`)) await new Promise(resolve => setTimeout(resolve, 50));
  const tradingFailureState = await evaluate(`({status: document.querySelector("#scan-status")?.textContent, message: document.querySelector("#scan-summary")?.textContent})`);
  assert.equal(tradingFailureState.status, "FRESH DAY TRADING", JSON.stringify(tradingFailureState));
  assert.ok(!tradingFailureState.message.includes("STALE"), JSON.stringify(tradingFailureState));
  assert.ok(!tradingFailureState.message.includes("Â·"), JSON.stringify(tradingFailureState));
  await evaluate(`document.querySelector("#refresh-button").click()`);
  const quickDeadline = Date.now() + 10000;
  let quickFailure;
  while (Date.now() < quickDeadline) {
    quickFailure = await evaluate(`({status: document.querySelector("#scan-status")?.textContent, summary: document.querySelector("#scan-summary")?.textContent})`);
    if (failedHourlyArtifactRequests > 0 && quickFailure.summary.includes("2/3")) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(failedHourlyArtifactRequests > 0, `Quick scan did not simulate hourly 404: ${failedHourlyArtifactRequests}`);
  assert.notEqual(quickFailure.status, "LIVE DAY TRADING", JSON.stringify(quickFailure));
  assert.ok(quickFailure.summary.includes("2/3"), JSON.stringify(quickFailure));
  assert.ok(quickFailure.summary.includes("artifact captured"), JSON.stringify(quickFailure));
  await pageSend("Page.navigate", { url: `http://127.0.0.1:${sitePort}/index.html?testScenario=trading-hangs` });
  const hangingStartedAt = Date.now();
  const hangingDeadline = hangingStartedAt + 2000;
  let hanging;
  while (Date.now() < hangingDeadline) {
    hanging = await evaluate(`({cards: document.querySelectorAll("#social-items .hype-card").length, status: document.querySelector("#social-status")?.textContent})`);
    if (hanging.cards === 6) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(hanging.cards, 6, JSON.stringify(hanging));
  assert.ok(Date.now() - hangingStartedAt < 2000, "Hype waited for the never-resolving Trading request");
  const hangingTradingSummary = await evaluate(`document.querySelector("#scan-summary")?.textContent || ""`);
  assert.ok(!/social|news/i.test(hangingTradingSummary), hangingTradingSummary);
  await pageSend("Page.navigate", { url: `http://127.0.0.1:${sitePort}/index.html?testScenario=trading-failure` });
  const returnedDeadline = Date.now() + 10000;
  let returned;
  while (Date.now() < returnedDeadline) {
    returned = await evaluate(`({cards: document.querySelectorAll("#social-items .hype-card").length, status: document.querySelector("#social-status")?.textContent})`);
    if (returned.cards === 6) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  await evaluate(`document.querySelector("#social-items .hype-card").open = true`);
  const expanded = await evaluate(`({width: document.documentElement.scrollWidth, headlines: document.querySelectorAll("#social-items .hype-card:first-child .headlines a").length, pairs: document.querySelectorAll("#social-items .pair-row").length, reddit: document.querySelector("#social-items").innerText.includes("Reddit unavailable (rate-limited)"), tiers: document.querySelector("#social-items .hype-card:first-child .hype-body").innerText, contract: document.querySelector("#social-items .contract-list code")?.textContent})`);
  assert.ok(expanded.width <= 390, JSON.stringify(expanded));
  assert.equal(expanded.headlines, 0, JSON.stringify(expanded));
  assert.equal(expanded.pairs, 2, JSON.stringify(expanded));
  assert.equal(expanded.reddit, true, JSON.stringify(expanded));
  assert.ok(expanded.tiers.includes("About this coin"), expanded.tiers);
  assert.ok(expanded.tiers.includes("Listed on 1 price-tracker pages (7d)"), expanded.tiers);
  assert.ok(expanded.tiers.includes("Related crypto buzz (headlines using 'Crawlerpad', not necessarily this coin): 5 in 7d"), expanded.tiers);
  assert.ok(expanded.tiers.includes("Crawlerpad news with crypto context"), expanded.tiers);
  assert.equal(expanded.contract, "CQCDTp8rsFV3PhaPeYjcCW5LdGTxi6jFx7eC3UXnpump");
  const dexStatusChecks = await evaluate(`(() => {
    const cards = [...document.querySelectorAll("#social-items .hype-card")];
    const results = {};
    for (const card of cards.slice(1, 5)) {
      card.open = true;
      results[card.querySelector("summary strong").textContent.trim().split(" ")[0]] = card.querySelector(".hype-body").innerText;
    }
    const pudgy = cards[5];
    pudgy.open = true;
    const picker = pudgy.querySelector(".pair-chain");
    picker.value = "ethereum";
    picker.dispatchEvent(new Event("change", { bubbles: true }));
    results.pudgyEthereum = pudgy.querySelector(".pair-results").innerText;
    return results;
  })()`);
  for (const [id, , , expected] of dexCases) assert.ok(dexStatusChecks[id].includes(expected), JSON.stringify(dexStatusChecks));
  assert.ok(dexStatusChecks.pudgyEthereum.includes("No DEX pairs found for this address"), JSON.stringify(dexStatusChecks));
  assert.ok(!dexStatusChecks.pudgyEthereum.includes("not supported"), JSON.stringify(dexStatusChecks));
  await pageSend("Page.navigate", { url: `http://127.0.0.1:${sitePort}/index.html?testScenario=identity-failure` });
  const identityDeadline = Date.now() + 10000;
  let failedIdentity;
  while (Date.now() < identityDeadline) {
    failedIdentity = await evaluate(`({cards: document.querySelectorAll("#social-items .hype-card").length, status: document.querySelector("#social-status")?.textContent})`);
    if (failedIdentity.cards === 6) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  await evaluate(`document.querySelector("#social-items .hype-card").open = true`);
  const failedIdentityText = await evaluate(`document.querySelector("#social-items .hype-card:first-child .hype-body").innerText`);
  assert.ok(failedIdentityText.includes("Contract lookup failed this capture (CoinGecko limit). Retry next hour"), failedIdentityText);
  await evaluate(`document.querySelector('[data-view="trading-view"]').click()`);
  const trading = await evaluate(`({active: document.querySelector("#trading-view")?.hidden === false, width: document.documentElement.scrollWidth})`);
  assert.equal(trading.active, true, JSON.stringify(trading));
  assert.ok(trading.width <= 390, JSON.stringify(trading));
  await pageSend("Page.navigate", { url: `http://127.0.0.1:${sitePort}/index.html?testScenario=hype-missing` });
  const reverseDeadline = Date.now() + 10000;
  let reverse;
  while (Date.now() < reverseDeadline) {
    reverse = await evaluate(`({hype: document.querySelector("#social-status")?.textContent, message: document.querySelector("#social-items")?.innerText, tradingStatus: document.querySelector("#scan-status")?.textContent})`);
    if (reverse.hype === "HYPE DATA UNAVAILABLE") break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(reverse.hype, "HYPE DATA UNAVAILABLE", JSON.stringify(reverse));
  assert.ok(reverse.message.includes("Hype data unavailable"), JSON.stringify(reverse));
  await evaluate(`document.querySelector('[data-view="trading-view"]').click()`);
  const reverseTradingDeadline = Date.now() + 10000;
  let reverseTrading;
  while (Date.now() < reverseTradingDeadline) {
    reverseTrading = await evaluate(`({active: document.querySelector("#trading-view")?.hidden === false, status: document.querySelector("#scan-status")?.textContent})`);
    if (reverseTrading.status === "FRESH DAY TRADING") break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(reverseTrading.active, true, JSON.stringify(reverseTrading));
  assert.equal(reverseTrading.status, "FRESH DAY TRADING", JSON.stringify(reverseTrading));
  await pageSend("Page.navigate", { url: `http://127.0.0.1:${sitePort}/index.html?testScenario=deep-artifact-failure` });
  const deepReadyDeadline = Date.now() + 10000;
  while (Date.now() < deepReadyDeadline && await evaluate(`document.querySelector("#refresh-button")?.disabled`)) await new Promise(resolve => setTimeout(resolve, 50));
  const loadingCopy = await evaluate(`document.querySelector("#scan-summary")?.textContent || ""`);
  assert.ok(!/social|news/i.test(loadingCopy), loadingCopy);
  await evaluate(`document.querySelector("#deep-scan-button").click()`);
  const deepDeadline = Date.now() + 25000;
  let deepPartial;
  while (Date.now() < deepDeadline) {
    deepPartial = await evaluate(`({status: document.querySelector("#scan-status")?.textContent, summary: document.querySelector("#scan-summary")?.textContent})`);
    if (deepPartial.status === "DEEP SCAN PARTIAL") break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(failedDailyArtifactRequests > 0, `Deep scan did not simulate daily artifact failure: ${failedDailyArtifactRequests}`);
  assert.equal(deepPartial.status, "DEEP SCAN PARTIAL", JSON.stringify(deepPartial));
  assert.ok(deepPartial.summary.includes("schedule artifacts refreshed (2/3)"), JSON.stringify(deepPartial));
  assert.match(deepPartial.summary, /artifact captured \d{4}-\d{2}-\d{2}T/, JSON.stringify(deepPartial));
  assert.ok(successfulTradingArtifactLoads > 0, `Trading artifacts were not served successfully: ${successfulTradingArtifactLoads}`);
  await pageSend("Page.navigate", { url: `http://127.0.0.1:${sitePort}/index.html?testScenario=cold-start-quick` });
  const quickColdStartDeadline = Date.now() + 10000;
  let quickColdStart;
  while (Date.now() < quickColdStartDeadline) {
    quickColdStart = await evaluate(`({status: document.querySelector("#scan-status")?.textContent, summary: document.querySelector("#scan-summary")?.textContent})`);
    if (/schedule artifacts refreshed \(2\/3\)/i.test(quickColdStart.summary)) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.match(quickColdStart.summary, /schedule artifacts refreshed \(2\/3\)/i, JSON.stringify(quickColdStart));
  assert.ok(quickColdStart.summary.includes("WEEKLY TRADING no prior capture"), JSON.stringify(quickColdStart));
  await pageSend("Page.navigate", { url: `http://127.0.0.1:${sitePort}/index.html?testScenario=cold-start-active-quick` });
  const activeQuickDeadline = Date.now() + 15000;
  let activeQuick;
  while (Date.now() < activeQuickDeadline) {
    activeQuick = await evaluate(`({status: document.querySelector("#scan-status")?.textContent, summary: document.querySelector("#scan-summary")?.textContent})`);
    if (/schedule artifacts refreshed \(2\/3\)/i.test(activeQuick.summary)) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.match(activeQuick.summary, /schedule artifacts refreshed \(2\/3\)/i, JSON.stringify(activeQuick));
  assert.ok(activeQuick.summary.includes("DAY TRADING no prior capture"), JSON.stringify(activeQuick));
  await pageSend("Page.navigate", { url: `http://127.0.0.1:${sitePort}/index.html?testScenario=cold-start-deep` });
  const coldDeepReadyDeadline = Date.now() + 10000;
  while (Date.now() < coldDeepReadyDeadline && await evaluate(`document.querySelector("#refresh-button")?.disabled`)) await new Promise(resolve => setTimeout(resolve, 50));
  await evaluate(`document.querySelector("#deep-scan-button").click()`);
  const coldDeepDeadline = Date.now() + 25000;
  let deepColdStart;
  while (Date.now() < coldDeepDeadline) {
    deepColdStart = await evaluate(`({status: document.querySelector("#scan-status")?.textContent, summary: document.querySelector("#scan-summary")?.textContent})`);
    if (deepColdStart.status === "DEEP SCAN PARTIAL") break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(deepColdStart.status, "DEEP SCAN PARTIAL", JSON.stringify(deepColdStart));
  assert.ok(deepColdStart.summary.includes("schedule artifacts refreshed (2/3)"), JSON.stringify(deepColdStart));
  assert.ok(deepColdStart.summary.includes("WEEKLY TRADING no prior capture"), JSON.stringify(deepColdStart));
  await pageSend("Page.navigate", { url: `http://127.0.0.1:${sitePort}/index.html?testScenario=live-ui` });
  await pageSend("Emulation.setDeviceMetricsOverride", { width: 375, height: 812, deviceScaleFactor: 1, mobile: true });
  const liveUiDeadline = Date.now() + 10000;
  let liveUi;
  while (Date.now() < liveUiDeadline) {
    liveUi = await evaluate(`({cards: document.querySelectorAll("#social-items .hype-card").length, status: document.querySelector("#social-status")?.textContent, scrollY: window.scrollY})`);
    if (liveUi.cards === 15) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(liveUi.cards, 15, JSON.stringify(liveUi));
  assert.equal(liveUi.scrollY, 0, JSON.stringify(liveUi));
  assert.ok(await evaluate(`!document.querySelector("#hype-view .notice")`), "Manual review banner must stay on Trading");
  const firstRow = await evaluate(`(() => { const row = document.querySelector("#social-items .hype-card"); const rect = row.getBoundingClientRect(); return {top: rect.top, bottom: rect.bottom, width: document.documentElement.scrollWidth}; })()`);
  assert.ok(firstRow.top < 812 && firstRow.bottom <= 812, JSON.stringify(firstRow));
  assert.ok(firstRow.width <= 375, JSON.stringify(firstRow));
  const firstRowLines = await evaluate(` [...document.querySelector("#social-items .hype-card .summary-lines").children].map(line => line.innerText)`);
  assert.equal(firstRowLines.length, 3, JSON.stringify(firstRowLines));
  assert.match(firstRowLines[0], /Wisp.*WISP.*robinhood.*Trending #1/i, JSON.stringify(firstRowLines));
  assert.match(firstRowLines[1], /24h .* \| Vol .* mcap \| pair .* old/i, JSON.stringify(firstRowLines));
  assert.match(firstRowLines[2], /FOMO flags \| About this coin:/i, JSON.stringify(firstRowLines));
  const warningBadge = await evaluate(`document.querySelector("#social-health span.warning")?.innerText || ""`);
  assert.match(warningBadge, /reddit.*rate-limited/i, warningBadge);
  const listPng = await pageSend("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  fs.mkdirSync(path.join(ROOT, ".proof"), { recursive: true });
  fs.writeFileSync(path.join(ROOT, ".proof", "r10-hype-list.png"), Buffer.from(listPng.data, "base64"));
  const openCard = async (symbol, file) => {
    await evaluate(`(() => { const card = [...document.querySelectorAll("#social-items .hype-card")].find(value => value.querySelector("summary").innerText.includes(${JSON.stringify(symbol)})); if (!card) throw new Error("Missing " + ${JSON.stringify(symbol)}); card.open = true; card.scrollIntoView({block: "start"}); })()`);
    await new Promise(resolve => setTimeout(resolve, 150));
    const shot = await pageSend("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    fs.writeFileSync(path.join(ROOT, ".proof", file), Buffer.from(shot.data, "base64"));
  };
  await openCard("CRAWLER", "r10-crawler-expanded.png");
  const crawlerCard = await evaluate(`(() => { const card = [...document.querySelectorAll("#social-items .hype-card")].find(value => value.querySelector("summary").innerText.includes("CRAWLER")); card.open = true; return {text: card.querySelector(".hype-body").innerText, fomo: [...card.querySelectorAll(".fomo-observations")].map(value => value.innerText)}; })()`);
  assert.match(crawlerCard.text, /CoinGecko 24h change\s+unknown/);
  assert.match(crawlerCard.text, /DEX primary pair 24h change \(pumpswap\)\s+\+6,787%/);
  assert.equal((crawlerCard.text.match(/captured/g) || []).length, 1, crawlerCard.text);
  const allFomoText = await evaluate(`(() => { document.querySelectorAll("#social-items .hype-card").forEach(card => card.open = true); return [...document.querySelectorAll("#social-items .fomo-observations")].map(value => value.innerText).join(" "); })()`);
  assert.ok(!/[{]|"age_seconds"/.test(allFomoText), allFomoText);
  assert.ok(crawlerCard.fomo.join(" ").includes("pumpswap"), JSON.stringify(crawlerCard.fomo));
  assert.ok(!crawlerCard.fomo.join(" ").includes("meteora"), JSON.stringify(crawlerCard.fomo));
  assert.ok(crawlerCard.fomo.join(" ").includes("AnrCHvfJUzMtos8DGjpT2XKurVPPYAVLDturASNwXcd4"), JSON.stringify(crawlerCard.fomo));
  const renderedPairList = await evaluate(`(() => { const card = [...document.querySelectorAll("#social-items .hype-card")].find(value => value.querySelector("summary").innerText.includes("CRAWLER")); return card.querySelector(".pair-list").innerText; })()`);
  assert.match(renderedPairList, /meteora/i, renderedPairList);
  assert.ok(crawlerCard.fomo.every(line => /CoinGecko|DEX Screener/.test(line)), JSON.stringify(crawlerCard.fomo));
  const identityText = await evaluate(`(() => { const cards = [...document.querySelectorAll("#social-items .hype-card")]; const results = {}; for (const symbol of ["QTC", "HYPE"]) { const card = cards.find(value => value.querySelector("summary").innerText.includes(symbol)); card.open = true; results[symbol] = card.querySelector(".hype-body").innerText; } return results; })()`);
  for (const symbol of ["QTC", "HYPE"]) {
    assert.ok(identityText[symbol].includes("UNVERIFIED_FORMAT"), `${symbol}: ${identityText[symbol]}`);
    assert.ok(!identityText[symbol].includes("Malformed"), `${symbol}: ${identityText[symbol]}`);
  }
  assert.equal(await evaluate(`(() => { const cards = [...document.querySelectorAll("#social-items .hype-card")]; return ["QTC", "HYPE"].every(symbol => { const card = cards.find(value => value.querySelector("summary").innerText.includes(symbol)); return [...card.querySelectorAll(".contract-list a")].length === 0; }); })()`), true);
  const linkContrast = await evaluate(`(() => { const link = document.querySelector("#social-items .pair-row a"); const background = getComputedStyle(link.closest(".pair-row")).backgroundColor; const foreground = getComputedStyle(link).color; const luminance = color => { const values = color.match(/[\\d.]+/g).slice(0, 3).map(Number).map(value => value / 255).map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4); return 0.2126 * values[0] + 0.7152 * values[1] + 0.0722 * values[2]; }; const ratio = (a, b) => (Math.max(luminance(a), luminance(b)) + 0.05) / (Math.min(luminance(a), luminance(b)) + 0.05); return {foreground, background, ratio: ratio(foreground, background)}; })()`);
  assert.ok(linkContrast.ratio >= 4.5, JSON.stringify(linkContrast));
  await openCard("PENGU", "r10-pengu-expanded.png");
  const penguCard = await evaluate(`(() => { const card = [...document.querySelectorAll("#social-items .hype-card")].find(value => value.querySelector("summary").innerText.includes("PENGU")); return {summary: card.querySelector("summary").innerText, observations: card.querySelector(".fomo-observations")?.innerText || "", pressureCount: card.querySelectorAll(".selling-pressure").length, flagCount: card.querySelectorAll(".fomo-flag").length}; })()`);
  assert.match(penguCard.observations, /Sells outnumber buys 2 : 1 in 24h \(40 \/ 20\)/, JSON.stringify(penguCard));
  assert.match(penguCard.observations, /meteora.*DEX Screener/i, JSON.stringify(penguCard));
  assert.match(penguCard.summary, /1 FOMO flags/, JSON.stringify(penguCard));
  assert.equal(penguCard.pressureCount, 1, JSON.stringify(penguCard));
  assert.equal(penguCard.flagCount, 1, JSON.stringify(penguCard));
  await pageSend("Page.navigate", { url: `http://127.0.0.1:${sitePort}/index.html?testScenario=live-ui-second` });
  const secondCaptureDeadline = Date.now() + 10000;
  let secondCaptureUi;
  while (Date.now() < secondCaptureDeadline) {
    secondCaptureUi = await evaluate(`({cards: document.querySelectorAll("#social-items .hype-card").length, status: document.querySelector("#social-status")?.textContent})`);
    if (secondCaptureUi.cards === 15) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(secondCaptureUi.cards, 15, JSON.stringify(secondCaptureUi));
  const secondMomentum = await evaluate(`(() => { const cards = [...document.querySelectorAll("#social-items .hype-card")]; const out = {}; for (const symbol of ["CRAWLER", "QTC", "BUNKER", "IMD6900"]) { const card = cards.find(value => value.querySelector("summary").innerText.includes(symbol)); card.open = true; out[symbol] = card.querySelector(".card-history").innerText; } return out; })()`);
  assert.match(secondMomentum.CRAWLER, /RISING/i, JSON.stringify(secondMomentum));
  assert.match(secondMomentum.QTC, /Rank #10 \(was #7\).*volume \+5\.5%.*mixed/i, JSON.stringify(secondMomentum));
  assert.match(secondMomentum.BUNKER, /Rank #4 \(was #3\).*volume \+13\.1%.*mixed/i, JSON.stringify(secondMomentum));
  assert.match(secondMomentum.IMD6900, /FADING/i, JSON.stringify(secondMomentum));
  await pageSend("Page.navigate", { url: `http://127.0.0.1:${sitePort}/index.html?testScenario=live-ui-strk-dedupe` });
  const strkDeadline = Date.now() + 10000;
  let strkReady;
  while (Date.now() < strkDeadline) {
    strkReady = await evaluate(`({cards: document.querySelectorAll("#social-items .hype-card").length})`);
    if (strkReady.cards === 15) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const strkFlags = await evaluate(`(() => { const card = [...document.querySelectorAll("#social-items .hype-card")].find(value => value.querySelector("summary").innerText.includes("STRK")); card.open = true; const flags = [...card.querySelectorAll(".fomo-flag")].map(row => row.innerText); return {flags, pressures: card.querySelectorAll(".selling-pressure").length, summary: card.querySelector("summary").innerText, picker: card.querySelector(".pair-chain")?.value, flagCount: card.querySelectorAll(".fomo-flag").length}; })()`);
  assert.equal(strkFlags.flagCount, 1, JSON.stringify(strkFlags));
  assert.ok(strkFlags.flagCount <= 5, JSON.stringify(strkFlags));
  assert.ok(strkFlags.flags.every(line => /pair .*0x06b3bf476b472ee9892ed93a668fa9ca64b85f2b2521e28fc00fb28612be0ead/i.test(line)), JSON.stringify(strkFlags));
  const strkAfterChainSelection = await evaluate(`(() => { const card = [...document.querySelectorAll("#social-items .hype-card")].find(value => value.querySelector("summary").innerText.includes("STRK")); const picker = card.querySelector(".pair-chain"); picker.value = "solana"; picker.dispatchEvent(new Event("change", {bubbles: true})); return {flags: [...card.querySelectorAll(".fomo-flag")].map(row => row.innerText), pairs: card.querySelector(".pair-results").innerText}; })()`);
  assert.deepEqual(strkAfterChainSelection.flags, strkFlags.flags, JSON.stringify(strkAfterChainSelection));
  assert.match(strkAfterChainSelection.pairs, /meteora|raydium/i, JSON.stringify(strkAfterChainSelection));
  assert.deepEqual(exceptions, []);
  console.log(JSON.stringify({ browser: "Microsoft Edge headless CDP", launchMode: simulateLauncherHandoff ? "simulated launcher handoff" : "direct Edge launch", launcherExitedBeforeCdp, viewport: "375x812 final acceptance", initial, quickFailure, hanging, failedHourlyArtifactRequests, tradingFailureState, expanded, dexStatusChecks, trading, reverse, reverseTrading, deepPartial, quickColdStart, deepColdStart, liveUi, firstRow, crawlerCard, penguCard, secondMomentum, strkFlags, strkAfterChainSelection, failedDailyArtifactRequests, successfulTradingArtifactLoads, screenshots: [".proof/r10-hype-list.png", ".proof/r10-crawler-expanded.png", ".proof/r10-pengu-expanded.png"], exceptions }, null, 2));
} catch (error) {
  runError = error;
} finally {
  const cleanup = async (label, action) => {
    try { await action(); } catch (error) { cleanupErrors.push(new Error(`${label}: ${error.stack || error}`)); }
  };
  await cleanup("Browser.close", async () => { if (shutdownBrowser) await shutdownBrowser(); });
  await cleanup("WebSocket close", async () => { if (ws && ws.readyState !== WebSocket.CLOSED) ws.close(); });
  await cleanup("Edge process cleanup", async () => {
    const processListingAvailable = stopEdgeProcessesForProfile(profile);
    if (!processListingAvailable) console.log("Edge cleanup: process listing is denied in this sandbox; Browser.close and the run-owned launcher handle the remaining cleanup.");
    if (!processListingAvailable && edge.exitCode === null) {
      edge.kill();
      await new Promise((resolve, reject) => { edge.once("exit", resolve); edge.once("error", reject); });
    }
    if (processListingAvailable && edge.exitCode === null) await Promise.race([new Promise(resolve => edge.once("exit", resolve)), new Promise(resolve => setTimeout(resolve, 2500))]);
    if (process.platform === "win32" && processListingAvailable && edge.exitCode === null) {
      stopEdgeProcessesForProfile(profile);
      await Promise.race([new Promise(resolve => edge.once("exit", resolve)), new Promise(resolve => setTimeout(resolve, 1000))]);
    }
    if (processListingAvailable && edge.exitCode === null) throw new Error("run-owned Edge launcher did not exit after Browser.close and profile-scoped cleanup");
    await new Promise(resolve => setTimeout(resolve, 100));
    try {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/version`, { signal: AbortSignal.timeout(500) });
      if (response.ok) throw new Error("CDP endpoint still responds after Browser.close and profile cleanup");
    } catch (error) {
      if (error.message === "CDP endpoint still responds after Browser.close and profile cleanup") throw error;
    }
  });
  await cleanup("HTTP server close", async () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  await cleanup("Profile removal", async () => fs.rmSync(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }));
  await cleanup("Temporary root removal", async () => {
    try { fs.rmdirSync(tempRoot); } catch (error) { if (error.code !== "ENOENT" && error.code !== "ENOTEMPTY") throw error; }
  });
}
if (runError) console.error(`Browser test failed: ${runError.stack || runError}`);
for (const error of cleanupErrors) console.error(`Browser test cleanup failed: ${error.stack || error}`);
if (runError && cleanupErrors.length) throw new AggregateError([runError, ...cleanupErrors], "Browser test and cleanup both failed");
if (runError) throw runError;
if (cleanupErrors.length) throw new AggregateError(cleanupErrors, "Browser test cleanup failed");
