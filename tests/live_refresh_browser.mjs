import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, ".test-tmp", "matt045", "browser-375x812");
const EDGE_CANDIDATES = [path.join(process.env.PROGRAMFILES || "C:\\Program Files", "Microsoft", "Edge", "Application", "msedge.exe"), path.join(process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)", "Microsoft", "Edge", "Application", "msedge.exe"), path.join(process.env.LOCALAPPDATA || "", "Microsoft", "Edge", "Application", "msedge.exe")];
const EDGE = EDGE_CANDIDATES.find(candidate => candidate && fs.existsSync(candidate));
assert.ok(EDGE, `Microsoft Edge not found at known install paths: ${EDGE_CANDIDATES.join(", ")}`);
assert.equal(typeof WebSocket, "function", "Node built-in WebSocket is required");

function stopEdgeProcessesForProfile(profile) {
  if (process.platform !== "win32") return true;
  const escaped = profile.replaceAll("'", "''");
  const script = `$profile = '${escaped}'; Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'msedge.exe' -and $_.CommandLine -like ('*' + $profile + '*') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`;
  try { execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {stdio: "pipe"}); return true; }
  catch (error) { if (/Access denied|0x80041003/i.test(String(error.stderr || error.message))) return false; throw error; }
}
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
const mime = file => ({".html":"text/html; charset=utf-8", ".js":"text/javascript; charset=utf-8", ".css":"text/css; charset=utf-8", ".json":"application/json; charset=utf-8", ".svg":"image/svg+xml"})[path.extname(file)] || "application/octet-stream";
const artifact = JSON.parse(fs.readFileSync(path.join(ROOT, "tests", "fixtures", "recorded", "live-collector-output-f494d74.json"), "utf8"));
const firstCapture = JSON.parse(fs.readFileSync(path.join(ROOT, "tests", "fixtures", "recorded", "live-collector-output-f494d74.json"), "utf8"));
const secondCapture = JSON.parse(fs.readFileSync(path.join(ROOT, "tests", "fixtures", "recorded", "live-collector-output-5f40129-second-capture.json"), "utf8"));
artifact.captured_at_utc = new Date().toISOString();
artifact.items.forEach(item => { if (item.observed_at_utc) item.observed_at_utc = artifact.captured_at_utc; });
const trending = JSON.parse(fs.readFileSync(path.join(ROOT, "tests", "fixtures", "coingecko-trending.json"), "utf8"));
const dexTemplate = JSON.parse(fs.readFileSync(path.join(ROOT, "tests", "fixtures", "dex-pairs.json"), "utf8"));
const rules = fs.readFileSync(path.join(ROOT, "data", "attention-rules.json"));
const requests = [];
const httpPaths = [];
const counts = {social: 0, rules: 0, trending: 0, dex: 0, dexAddresses: []};
let sitePort;
let serverOffline = false;
const server = http.createServer((request, response) => {
  if (serverOffline) { request.socket.destroy(); return; }
  const url = new URL(request.url, "http://127.0.0.1");
  const pathname = decodeURIComponent(url.pathname);
  httpPaths.push(pathname);
  const appPathname = pathname.startsWith("/crypto-hourly-desk/") ? pathname.slice("/crypto-hourly-desk".length) : pathname;
  const scenario = url.searchParams.get("scenario") || new URL(request.headers.referer || "http://127.0.0.1").searchParams.get("scenario") || "success";
  const reply = (status, body) => response.writeHead(status, {"content-type":"application/json; charset=utf-8", "cache-control":"no-store"}).end(typeof body === "string" ? body : JSON.stringify(body));
  if (appPathname === "/") { response.writeHead(302, {location:"/crypto-hourly-desk/index.html"}).end(); return; }
  if (appPathname === "/data/social-context-v2-latest.json") {
    if (url.searchParams.has("_fresh")) { counts.social += 1; requests.push("artifact"); }
    setTimeout(() => reply(200, artifact), 120);
    return;
  }
  if (appPathname === "/data/attention-rules.json") { if (url.searchParams.has("_fresh")) { counts.rules += 1; requests.push("rules"); } if (scenario === "rules-failure") { response.writeHead(503).end("rule table unavailable"); return; } reply(200, rules.toString("utf8")); return; }
  if (appPathname === "/mock-coingecko/trending") {
    counts.trending += 1; requests.push("coingecko");
    if (scenario === "cg-failure") { reply(429, {error:"Too Many Requests"}); return; }
    let payload = structuredClone(trending);
    if (scenario === "new-coin") payload.coins.unshift({item:{id:"unmatched-brand-new-token", name:"Brand New Token", symbol:"NEW", data:{price:1, market_cap:"$10,000,000", total_volume:"$2,000,000", price_change_percentage_24h:{usd:9}}}});
    reply(200, payload); return;
  }
  if (appPathname.startsWith("/mock-dex/token-pairs/v1/")) {
    counts.dex += 1; requests.push("dex");
    const parts = pathname.split("/");
    const chain = parts.at(-2), address = parts.at(-1);
    counts.dexAddresses.push({chain, address});
    if (scenario === "dex-failure") { reply(503, {error:"temporarily unavailable"}); return; }
    const pairs = structuredClone(dexTemplate).map(pair => ({...pair, chainId: chain, baseToken: {...pair.baseToken, address}}));
    reply(200, pairs); return;
  }
  if (appPathname.startsWith("/mock-kraken/")) {
    const endpoint = appPathname.split("/").at(-1);
    const payload = endpoint === "AssetPairs" ? {result:{XXBTZUSD:{status:"online",wsname:"BTC/USD"}}} : endpoint === "OHLC" ? {result:{XXBTZUSD:[[1,"100","105","95","101","100","200",50],[2,"101","106","96","102","100","200",50],[3,"102","107","97","103","100","200",50]],last:3}} : {result:{XXBTZUSD:{c:["100"],b:["99.99"],a:["100.01"],o:"99",h:["105","105"],l:["95","95"],v:["100","100000"]}}};
    reply(200, payload); return;
  }
  const target = path.resolve(ROOT, `.${appPathname}`);
  if (target !== ROOT && !target.startsWith(ROOT + path.sep)) { response.writeHead(403).end("forbidden"); return; }
  fs.readFile(target, (error, content) => {
    if (error) { response.writeHead(404).end("not found"); return; }
    if (appPathname === "/app.js") content = Buffer.from(content.toString("utf8").replaceAll("https://api.kraken.com/0/public", `http://127.0.0.1:${sitePort}/mock-kraken`).replace("https://api.coingecko.com/api/v3/search/trending", `http://127.0.0.1:${sitePort}/mock-coingecko/trending`).replace("https://api.dexscreener.com/token-pairs/v1", `http://127.0.0.1:${sitePort}/mock-dex/token-pairs/v1`));
    response.writeHead(200, {"content-type":mime(target), "cache-control":"no-store"}).end(content);
  });
});
await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
sitePort = server.address().port;
const debugPort = await freePort();
fs.mkdirSync(OUT, {recursive:true});
const profile = fs.mkdtempSync(path.join(ROOT, ".test-tmp", "matt045-edge-profile-"));
const edge = spawn(EDGE, ["--headless=new", "--no-sandbox", "--disable-gpu", "--disable-extensions", "--no-first-run", "--no-default-browser-check", "--no-proxy-server", "--remote-allow-origins=*", `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, "about:blank"], {stdio:["ignore","ignore","pipe"], windowsHide:true});
let ws, target, browserClosed = false, runError = null;
const browserErrors = [];
const pending = new Map();
let commandId = 0;
const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++commandId; pending.set(id, {resolve, reject}); ws.send(JSON.stringify({id, method, params})); });
async function evaluate(expression) {
  const result = await send("Runtime.evaluate", {expression, returnByValue:true, awaitPromise:true});
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || JSON.stringify(result.exceptionDetails));
  return result.result?.value;
}
async function waitFor(test, label, timeout = 15000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { const value = await evaluate(test); if (value) return value; await new Promise(resolve => setTimeout(resolve, 75)); }
  throw new Error(`Timed out waiting for ${label}`);
}
try {
  let wsUrl;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try { const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`); const pages = await response.json(); target = pages.find(row => row.type === "page"); if (target?.webSocketDebuggerUrl) { wsUrl = target.webSocketDebuggerUrl; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(wsUrl, "Edge CDP page target did not start");
  ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => { ws.addEventListener("open", resolve, {once:true}); ws.addEventListener("error", reject, {once:true}); });
  ws.addEventListener("message", event => { const message = JSON.parse(event.data); if (message.method === "Runtime.exceptionThrown") browserErrors.push(message.params.exceptionDetails); if (message.id && pending.has(message.id)) { const slot = pending.get(message.id); pending.delete(message.id); message.error ? slot.reject(new Error(message.error.message)) : slot.resolve(message.result); } });
  await send("Page.enable"); await send("Runtime.enable"); await send("Network.enable");
  await send("Emulation.setDeviceMetricsOverride", {width:375, height:812, deviceScaleFactor:1, mobile:true});
  await send("Page.navigate", {url:`http://127.0.0.1:${sitePort}/crypto-hourly-desk/index.html?scenario=success`});
  // Boot, visible-again and button events overlap while the artifact response is held.
  await new Promise(resolve => setTimeout(resolve, 30));
  await evaluate(`document.dispatchEvent(new Event("visibilitychange")); document.querySelector("#hype-refresh-button").click()`);
  let success;
  try { success = await waitFor(`document.querySelector("#hype-refresh-status")?.textContent.startsWith("Updated live") && document.querySelectorAll("#social-items .hype-card").length > 0`, "successful Hype refresh"); }
  catch (error) { const debug = await evaluate(`({url:location.href,status:document.querySelector("#hype-refresh-status")?.textContent,summary:document.querySelector("#social-summary")?.textContent,cards:document.querySelectorAll("#social-items .hype-card").length,buttonDisabled:document.querySelector("#hype-refresh-button")?.disabled,refreshType:typeof window.refreshHype,evaluatorType:typeof window.evaluateAttentionRules,requests:${JSON.stringify(requests)},httpPaths:${JSON.stringify(httpPaths)},scripts:[...document.scripts].map(script=>({src:script.src,loaded:Boolean(script.isConnected)})),counts:${JSON.stringify(counts)},browserErrors:${JSON.stringify(browserErrors)}})`); throw new Error(`${error.message}; startup state ${JSON.stringify(debug)}`); }
  assert.equal(counts.social, 1, `coalesced social fetch count ${counts.social}; request order ${JSON.stringify(requests)}`);
  assert.equal(counts.trending, 1, `one CoinGecko request ${counts.trending}`);
  assert.ok(counts.dex > 0, "known address DEX calls were made");
  const successView = await evaluate(`(() => { const cards=[...document.querySelectorAll("#social-items .hype-card")]; const crawler=cards.find(card=>card.textContent.includes("CRAWLER")); if(crawler) crawler.open=true; return {cards:cards.length, status:document.querySelector("#hype-refresh-status").innerText, summary:document.querySelector("#social-summary").innerText, crawler:crawler?.textContent, buttonHeight:document.querySelector("#hype-refresh-button").getBoundingClientRect().height, width:document.documentElement.scrollWidth, deviceWidth:innerWidth, requests:[...document.querySelectorAll("#social-items .hype-card")].map(card=>card.querySelector("summary")?.innerText)}; })()`);
  assert.equal(successView.width, 375, JSON.stringify(successView));
  assert.ok(successView.buttonHeight >= 44, JSON.stringify(successView));
  assert.match(successView.summary, /Live CoinGecko and DEX values captured.*background capture/i);
  assert.match(successView.crawler, /momentum since background capture.*live values captured/i);
  assert.match(successView.crawler, /CoinGecko price \(live\)/i);
  const primaryPairCheck = await evaluate(`(() => {
    const item={coingecko_id:"primary-check",name:"Primary Check",symbol:"PRI",trending:{rank:1},market:{},identity:{contracts:[{chain:"ethereum",dex_status:"FRESH"},{chain:"solana",dex_status:"FRESH"}]},mentions:{},fomo_watch:{status:"UNKNOWN",observations:[]},dex_pairs:[
      {coingecko_platform:"solana",dex_id:"sol-dex",pair_address:"sol-pair",liquidity_usd:100,price_change_by_period:{h24:4},age_seconds:10},
      {coingecko_platform:"ethereum",dex_id:"eth-dex",pair_address:"eth-pair",liquidity_usd:900,price_change_by_period:{h24:8},age_seconds:20}
    ]};
    const first=window.primaryHypePair(item)?.pair_address;
    item.dex_pairs.reverse();
    const reversed=window.primaryHypePair(item)?.pair_address;
    window.renderHype({captured_at_utc:new Date().toISOString(),items:[item]});
    const card=document.querySelector("#social-items .hype-card"); card.open=true;
    const primaryLabel=[...card.querySelectorAll(".metric span")].find(label=>label.textContent.startsWith("DEX primary pair"))?.textContent;
    const select=card.querySelector(".pair-chain"); select.value="solana"; select.dispatchEvent(new Event("change"));
    const solanaLabels=card.querySelector(".pair-results").textContent;
    select.value="ethereum"; select.dispatchEvent(new Event("change"));
    const ethereumLabels=card.querySelector(".pair-results").textContent;
    return {first,reversed,primaryLabel,solanaLabels,ethereumLabels};
  })()`);
  assert.equal(primaryPairCheck.first, "eth-pair", JSON.stringify(primaryPairCheck));
  assert.equal(primaryPairCheck.reversed, "eth-pair", JSON.stringify(primaryPairCheck));
  assert.match(primaryPairCheck.primaryLabel, /eth-dex/, JSON.stringify(primaryPairCheck));
  assert.doesNotMatch(primaryPairCheck.solanaLabels, /Primary pair/, JSON.stringify(primaryPairCheck));
  assert.match(primaryPairCheck.ethereumLabels, /Primary pair \(highest known liquidity\)/, JSON.stringify(primaryPairCheck));
  const parityCases = ["crawlerpad", "pudgy-penguins"].map(id => ({current:firstCapture.items.find(item=>item.coingecko_id===id), prior:null}));
  const momentumCases = ["crawlerpad", "quantus", "bunker-mode", "identity-md-6900"].map(id => ({current:secondCapture.items.find(item=>item.coingecko_id===id), prior:firstCapture.items.find(item=>item.coingecko_id===id)}));
  const parityReplay = await evaluate(`(() => { const rules=${JSON.stringify(JSON.parse(rules.toString("utf8")))}; const observations=${JSON.stringify(parityCases)}.map(row=>({id:row.current.coingecko_id,result:window.evaluateAttentionRules(row.current,rules,row.prior)})); const momentum=${JSON.stringify(momentumCases)}.map(row=>({id:row.current.coingecko_id,state:window.evaluateAttentionRules(row.current,rules,row.prior).momentum.state})); const missing=window.calculateAttentionMomentum(null,null,null,null,rules,false); return {observations,momentum,missing}; })()`);
  const crawlerReplay = parityReplay.observations.find(row => row.id === "crawlerpad").result;
  const crawlerFlags = crawlerReplay.observations.filter(row => row.kind !== "SELLING_PRESSURE");
  assert.equal(crawlerReplay.primaryPair.dex_id, "pumpswap");
  assert.ok(crawlerFlags.filter(row => row.pair_address).every(row => row.dex_id === "pumpswap" && row.pair_address === crawlerReplay.primaryPair.pair_address), JSON.stringify(crawlerFlags));
  assert.ok(crawlerFlags.filter(row => row.pair_address).every(row => row.source.startsWith("pumpswap DEX Screener")), JSON.stringify(crawlerFlags));
  const penguReplay = parityReplay.observations.find(row => row.id === "pudgy-penguins").result;
  const pressurePair = penguReplay.observations.filter(row => row.kind === "SELLING_PRESSURE" && row.buys_24h === 20 && row.sells_24h === 40);
  assert.equal(pressurePair.length, 1, JSON.stringify(pressurePair));
  assert.ok(!penguReplay.observations.some(row => row.kind === "BUY_SELL_IMBALANCE" && row.pair_address === pressurePair[0].pair_address));
  assert.deepEqual(Object.fromEntries(parityReplay.momentum.map(row=>[row.id,row.state])), {crawlerpad:"RISING",quantus:"MIXED","bunker-mode":"MIXED","identity-md-6900":"FADING"});
  assert.equal(parityReplay.missing.state, "INSUFFICIENT_HISTORY");
  const boundaryCases = await evaluate(`(() => {
    const rules=${JSON.stringify(JSON.parse(rules.toString("utf8")))};
    const base={coingecko_id:"boundary",name:"Boundary Token",symbol:"BND",observed_at_utc:new Date().toISOString(),trending:{rank:10,previous_rank:10},market:{price_usd:1,market_cap_usd:1000,volume_24h_usd:100,volume_market_cap_ratio:0.1},identity:{contracts:[]},mentions:{google_news:{status:"NOT_QUERIED",headlines:[]},reddit:{status:"NOT_QUERIED",headlines:[]}},dex_pairs:[{is_primary:true,dex_id:"testdex",pair_address:"boundary-pair",liquidity_usd:500,fdv_usd:1000,age_seconds:90000,price_change_by_period:{h24:100},buys_sells_by_period:{h24:{buys:10,sells:10}}}],fomo_watch:{status:"UNKNOWN",observations:[]}};
    const prior={observed_at_utc:new Date(Date.now()-3600000).toISOString(),trending:{rank:10},market:{volume_24h_usd:100}};
    const result={};
    for(const volume of [105,95]) {
      const item=structuredClone(base); item.market.volume_24h_usd=volume;
      const computed=window.evaluateAttentionRules(item,rules,prior);
      item.momentum=computed.momentum; item.fomo_watch={status:computed.observations.length?"WATCH_ONLY":"UNKNOWN",observations:computed.observations};
      window.renderHype({captured_at_utc:item.observed_at_utc,items:[item]});
      document.querySelector("#social-items .hype-card").open=true;
      const text=document.querySelector("#social-items").innerText;
      result[String(volume)]={state:computed.momentum.state,volume_change_pct:computed.momentum.volume_change_pct,flags:(text.match(/FOMO flags/g)||[]).length?Number(text.match(/(\\d+) FOMO flags/)?.[1]):-1,card:text};
    }
    const item=structuredClone(base); const exactly100=window.evaluateAttentionRules(item,rules,null);
    item.momentum=exactly100.momentum; item.fomo_watch={status:"UNKNOWN",observations:exactly100.observations};
    window.renderHype({captured_at_utc:item.observed_at_utc,items:[item]});
    document.querySelector("#social-items .hype-card").open=true;
    result.dex100={observations:exactly100.observations.map(row=>row.kind),card:document.querySelector("#social-items").innerText};
    item.dex_pairs[0].price_change_by_period.h24=100.01;
    const above100=window.evaluateAttentionRules(item,rules,null);
    item.fomo_watch={status:"WATCH_ONLY",observations:above100.observations}; window.renderHype({captured_at_utc:item.observed_at_utc,items:[item]});
    document.querySelector("#social-items .hype-card").open=true;
    result.dexAbove100={observations:above100.observations.map(row=>row.kind),card:document.querySelector("#social-items").innerText};
    return result;
  })()`);
  for (const volume of [105,95]) { assert.equal(boundaryCases[String(volume)].state, "FLAT", JSON.stringify(boundaryCases[String(volume)])); assert.match(boundaryCases[String(volume)].card, /flat/); }
  assert.deepEqual(boundaryCases.dex100.observations, []);
  assert.match(boundaryCases.dex100.card, /0 FOMO flags/);
  assert.deepEqual(boundaryCases.dexAbove100.observations, ["DEX_PRICE_MOVE"]);
  assert.match(boundaryCases.dexAbove100.card, /1 FOMO flags/);
  await send("Page.captureScreenshot", {format:"png", captureBeyondViewport:false}).then(result => fs.writeFileSync(path.join(OUT, "success-live-merge.png"), Buffer.from(result.data,"base64")));
  const initialStarts = counts.trending;
  await evaluate(`document.querySelector("#hype-refresh-button").click()`);
  const cooldown = await evaluate(`document.querySelector("#hype-refresh-status").textContent`);
  assert.match(cooldown, /Refreshed \d+s ago, try again in \d+s/);
  assert.equal(counts.trending, initialStarts, "cooldown avoids repeat CoinGecko requests");

  await send("Page.navigate", {url:`http://127.0.0.1:${sitePort}/index.html?scenario=new-coin`});
  await waitFor(`document.querySelector("#hype-refresh-status")?.textContent.startsWith("Updated live")`, "new coin live view");
  const newCoin = await evaluate(`(() => { const card=[...document.querySelectorAll("#social-items .hype-card")].find(row=>row.textContent.includes("Brand New Token")); if(card) card.open=true; return {text:card?.textContent, dex:document.querySelectorAll("#social-items .hype-card").length, width:document.documentElement.scrollWidth}; })()`);
  assert.match(newCoin.text, /address not checked yet \(next background refresh\)/);
  assert.equal(counts.dexAddresses.filter(row => row.address === "undefined").length, 0);
  assert.ok(counts.dexAddresses.every(({address}) => artifact.items.some(item => (item.identity?.contracts || []).some(contract => contract.address === address))), "DEX requests use only artifact-known contract addresses");
  assert.equal(newCoin.width, 375, JSON.stringify(newCoin));
  await send("Page.captureScreenshot", {format:"png", captureBeyondViewport:false}).then(result => fs.writeFileSync(path.join(OUT, "new-coin.png"), Buffer.from(result.data,"base64")));

  for (const scenario of ["rules-failure", "cg-failure", "dex-failure"]) {
    await send("Page.navigate", {url:`http://127.0.0.1:${sitePort}/index.html?scenario=${scenario}`});
    await waitFor(`document.querySelector("#hype-refresh-status")?.textContent.startsWith("Live refresh failed")`, `${scenario} fallback`);
    const fallback = await evaluate(`({status:document.querySelector("#hype-refresh-status").textContent, summary:document.querySelector("#social-summary").textContent, cards:document.querySelectorAll("#social-items .hype-card").length, width:document.documentElement.scrollWidth, liveLabels:[...document.querySelectorAll("#social-items .metric span")].filter(row=>row.innerText.includes("(live)")).length})`);
    assert.match(fallback.status, /showing background capture/);
    assert.match(fallback.summary, /Background artifact captured/);
    assert.ok(fallback.cards > 0, JSON.stringify(fallback));
    assert.equal(fallback.width, 375, JSON.stringify(fallback));
    assert.equal(fallback.liveLabels, 0, "failed live request retains an artifact-only view");
    await send("Page.captureScreenshot", {format:"png", captureBeyondViewport:false}).then(result => fs.writeFileSync(path.join(OUT, `${scenario}-fallback.png`), Buffer.from(result.data,"base64")));
  }
  await evaluate(`navigator.serviceWorker.ready.then(() => true)`);
  const serviceWorkerState = await evaluate(`(async()=>({secure:window.isSecureContext,controller:Boolean(navigator.serviceWorker.controller),registrations:(await navigator.serviceWorker.getRegistrations()).map(reg=>({scope:reg.scope,active:reg.active?.state,waiting:reg.waiting?.state,installing:reg.installing?.state}))}))()`);
  await send("Page.navigate", {url:`http://127.0.0.1:${sitePort}/crypto-hourly-desk/index.html`});
  await waitFor(`navigator.serviceWorker.controller && document.querySelector("#hype-refresh-status")`, `service worker control ${JSON.stringify(serviceWorkerState)}`);
  await send("Network.emulateNetworkConditions", {offline:true, latency:0, downloadThroughput:0, uploadThroughput:0, connectionType:"none"});
  serverOffline = true;
  await send("Page.reload", {ignoreCache:true});
  try { await waitFor(`document.querySelector("#hype-refresh-status")?.textContent.startsWith("Live refresh failed") && document.querySelectorAll("#social-items .hype-card").length > 0`, "offline cached artifact fallback", 20000); }
  catch (error) { const debug = await evaluate(`(async()=>({url:location.href,status:document.querySelector("#hype-refresh-status")?.textContent,summary:document.querySelector("#social-summary")?.textContent,cards:document.querySelectorAll("#social-items .hype-card").length,controller:Boolean(navigator.serviceWorker.controller),caches:await caches.keys()}))()`); throw new Error(`${error.message}; offline state ${JSON.stringify(debug)}; prior ${JSON.stringify(serviceWorkerState)}`); }
  const offline = await evaluate(`({status:document.querySelector("#hype-refresh-status").textContent,summary:document.querySelector("#social-summary").textContent,cards:document.querySelectorAll("#social-items .hype-card").length,cacheController:Boolean(navigator.serviceWorker.controller)})`);
  assert.match(offline.status, /showing background capture/);
  assert.match(offline.summary, /Background artifact captured/);
  assert.match(offline.summary, /\(\d+m old; stale after 2h\)/);
  assert.ok(offline.cards > 0, JSON.stringify(offline));
  await send("Page.captureScreenshot", {format:"png", captureBeyondViewport:false}).then(result => fs.writeFileSync(path.join(OUT, "offline-cached-artifact.png"), Buffer.from(result.data,"base64")));
  serverOffline = false;
  await send("Network.emulateNetworkConditions", {offline:false, latency:0, downloadThroughput:-1, uploadThroughput:-1, connectionType:"none"});
  const report = {browser:"Microsoft Edge headless CDP", viewport:"375x812 CSS px via Emulation.setDeviceMetricsOverride", deploymentBasePath:"/crypto-hourly-desk/", primaryPairCheck, success:successView, parityReplay, boundaryCases, offline, cooldown, newCoin, requestCounts:counts, requestOrder:requests, scenarios:["coalesced boot/visibility/button", "live merge", "new coin without address lookup", "attention-rule load failure fallback", "CoinGecko rate limit fallback", "DEX failure fallback", "Python/JavaScript shared-capture parity outcomes", "exact 100% DEX and +/-5% volume UI parity", "global primary pair labels independent of pair order and selected chain", "offline cached artifact startup at /crypto-hourly-desk/ with capture age"], screenshots:["success-live-merge.png","new-coin.png","rules-failure-fallback.png","cg-failure-fallback.png","dex-failure-fallback.png","offline-cached-artifact.png"]};
  fs.writeFileSync(path.join(OUT, "results.json"), JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
} catch (error) { runError = error; }
finally {
  const cleanupErrors = [];
  const cleanup = async (label, action) => { try { await action(); } catch (error) { cleanupErrors.push(new Error(`${label}: ${error.stack || error}`)); } };
  await cleanup("Browser.close", async () => { if (ws?.readyState === WebSocket.OPEN) { await send("Browser.close"); browserClosed = true; } });
  await cleanup("WebSocket close", async () => { if (ws && ws.readyState !== WebSocket.CLOSED) ws.close(); });
  await cleanup("Edge process cleanup", async () => {
    const processListingAvailable = stopEdgeProcessesForProfile(profile);
    if (!processListingAvailable && edge.exitCode === null) edge.kill();
    if (processListingAvailable && edge.exitCode === null) await Promise.race([new Promise(resolve => edge.once("exit", resolve)), new Promise(resolve => setTimeout(resolve, 2500))]);
    if (process.platform === "win32" && processListingAvailable && edge.exitCode === null) { stopEdgeProcessesForProfile(profile); await Promise.race([new Promise(resolve => edge.once("exit", resolve)), new Promise(resolve => setTimeout(resolve, 1000))]); }
    if (processListingAvailable && edge.exitCode === null) throw new Error("run-owned Edge launcher did not exit after profile-scoped cleanup");
    try { const response = await fetch(`http://127.0.0.1:${debugPort}/json/version`, {signal:AbortSignal.timeout(500)}); if (response.ok) throw new Error("CDP endpoint remains open after browser cleanup"); } catch (error) { if (error.message.includes("remains open")) throw error; }
  });
  await cleanup("HTTP server close", async () => new Promise((resolve,reject) => server.close(error => error ? reject(error) : resolve())));
  await cleanup("Profile removal", async () => fs.rmSync(profile,{recursive:true,force:true,maxRetries:8,retryDelay:250}));
  if (runError && cleanupErrors.length) throw new AggregateError([runError,...cleanupErrors],"browser run and cleanup failed");
  if (runError) throw runError;
  if (cleanupErrors.length) throw new AggregateError(cleanupErrors,"browser cleanup failed");
}
