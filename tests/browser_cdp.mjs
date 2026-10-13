import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
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
uiFixtureData.source_health.reddit = { status: "DEGRADED", error_class: "RATE_LIMITED" };
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
    response.end(scenario === "identity-failure" ? identityFailureFixture : uiFixture);
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
const profile = fs.mkdtempSync(path.join(ROOT, ".test-tmp", "market-attention-edge-"));
const edge = spawn(EDGE, [
  "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-extensions", "--no-first-run", "--no-default-browser-check",
  "--no-proxy-server", "--remote-allow-origins=*", `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`,
  "about:blank",
], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
let edgeStderr = "";
edge.stderr.setEncoding("utf8").on("data", chunk => { edgeStderr += chunk; });
let ws;
let shutdownBrowser;
try {
  let version;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/version`);
      if (response.ok) { version = await response.json(); break; }
    } catch {}
    if (edge.exitCode !== null) throw new Error(`Edge exited early: ${edgeStderr}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(version, `Edge CDP did not start: ${edgeStderr}`);
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
  shutdownBrowser = () => { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ id: 999999, method: "Browser.close" })); };
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
  assert.deepEqual(exceptions, []);
  console.log(JSON.stringify({ browser: "Microsoft Edge headless CDP", viewport: "390x844", initial, quickFailure, hanging, failedHourlyArtifactRequests, tradingFailureState, expanded, dexStatusChecks, trading, reverse, reverseTrading, deepPartial, quickColdStart, deepColdStart, failedDailyArtifactRequests, successfulTradingArtifactLoads, exceptions }, null, 2));
} finally {
  try { shutdownBrowser?.(); } catch {}
  try { ws?.close(); } catch {}
  if (edge.exitCode === null) await Promise.race([new Promise(resolve => edge.once("exit", resolve)), new Promise(resolve => setTimeout(resolve, 2500))]);
  if (edge.exitCode === null) edge.kill();
  if (edge.exitCode === null) await new Promise(resolve => edge.once("exit", resolve));
  await new Promise(resolve => server.close(resolve));
  fs.rmSync(profile, { recursive: true, force: true });
}
