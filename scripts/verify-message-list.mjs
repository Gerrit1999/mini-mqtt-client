import { createServer } from "vite";
import vue from "@vitejs/plugin-vue";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const root = process.cwd();
const driver = process.env.PLAYWRIGHT_MODULE;
if (!driver) throw new Error("Set PLAYWRIGHT_MODULE to playwright's index.mjs (see evidence doc).");
const { chromium } = await import(pathToFileURL(resolve(driver)).href);
const temp = await mkdtemp(resolve(root, ".issue31-browser-"));
let server, browser;
try {
  const baseline = execFileSync("git", ["show", "0ff39c0ff530321273ee1bc92b0ba94271b0c2f0:src/components/mqtt/MessageList.vue"], { encoding: "utf8" });
  await writeFile(resolve(temp, "Baseline.vue"), baseline.replace('"./MessagePayload.vue"', '"@/components/mqtt/MessagePayload.vue"'));
  await writeFile(resolve(temp, "index.html"), '<style>html,body,#app{height:100%;margin:0}#app{height:780px}.message-list{height:100%}</style><div id="app"></div><script type="module" src="./entry.ts"></script>');
  await writeFile(resolve(temp, "entry.ts"), `
    import { createApp } from 'vue';
    import ElementPlus from 'element-plus';
    import 'element-plus/dist/index.css';
    import { createI18n } from 'vue-i18n';
    import '../scripts/issue31-fixture';
    import Changed from '@/components/mqtt/MessageList.vue';
    import Baseline from './Baseline.vue';
    import '../src/assets/styles/index.scss';
    const component = new URLSearchParams(location.search).get('version') === 'before' ? Baseline : Changed;
    const begin = performance.now();
    window.renderStart = begin;
    const app = createApp(component).use(ElementPlus).use(createI18n({legacy:false,locale:'en',missing:(_l,k)=>k}));
    app.mount('#app');
    requestAnimationFrame(()=>requestAnimationFrame(()=>window.renderElapsed = performance.now()-begin));
  `);
  const fixture = resolve(root, "scripts/issue31-fixture.ts");
  server = await createServer({ configFile: false, root: temp, plugins: [vue()],
    resolve: { alias: [
      ...["server", "mqtt", "message", "app", "subscription"].map((name) => ({ find: `@/stores/${name}`, replacement: fixture })),
      { find: "@tauri-apps/plugin-dialog", replacement: fixture },
      { find: "@tauri-apps/plugin-fs", replacement: fixture },
      { find: "@", replacement: resolve(root, "src") },
    ] }, server: { host: "127.0.0.1", port: 0, fs: { allow: [root] } } });
  await server.listen();
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/usr/bin/chromium", headless: true, args: ["--no-sandbox"] });
  const url = server.resolvedUrls.local[0];
  await verifyReviewRegressions(browser, url);
  const results = [];
  for (let sample = 1; sample <= Number(process.env.BENCHMARK_SAMPLES ?? 3); sample++) {
  for (const version of ["before", "after"]) {
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    page.on("pageerror", (error) => console.error("Browser error:", error.message));
    await page.addInitScript(() => {
      window.longTasks = [];
      new PerformanceObserver((list) => window.longTasks.push(...list.getEntries().map((e) => ({ start: e.startTime, duration: e.duration })))).observe({ type: "longtask", buffered: true });
    });
    await page.goto(`${url}?version=${version}&count=3000`);
    await page.waitForFunction(() => window.renderElapsed && document.querySelectorAll(".message-row").length);
    const metrics = await page.evaluate(async () => {
      const viewport = document.querySelector(".message-scroll-wrapper");
      const mountedRows = document.querySelectorAll(".message-row").length;
      const domNodes = document.querySelectorAll("*").length;
      const scrollStart = performance.now();
      const renderEnd = window.renderStart + window.renderElapsed;
      const frames = []; let previous = performance.now();
      for (let i = 0; i < 120; i++) {
        await new Promise(requestAnimationFrame);
        const now = performance.now(); frames.push(now - previous); previous = now;
        viewport.scrollTop = (viewport.scrollHeight - viewport.clientHeight) * (i / 119);
      }
      await new Promise(requestAnimationFrame);
      const renderTasks = window.longTasks.filter((t) => t.start + t.duration > window.renderStart && t.start < renderEnd);
      const scrollTasks = window.longTasks.filter((t) => t.start >= scrollStart);
      return { renderMs: window.renderElapsed, mountedRows, domNodes,
        scrollFrames: frames.length, framesOver32ms: frames.filter((v) => v > 32).length,
        maxFrameMs: Math.max(...frames), renderLongTasks: renderTasks.length,
        renderLongTaskMs: renderTasks.reduce((a,b)=>a+Math.max(0, Math.min(b.start+b.duration, renderEnd)-Math.max(b.start,window.renderStart)),0),
        scrollLongTasks: scrollTasks.length, scrollLongTaskMs: scrollTasks.reduce((a,b)=>a+b.duration,0) };
    });
    results.push({ sample, version, ...metrics });
    if (version === "after" && sample === 1) {
      assert(metrics.mountedRows < 40, "bounded mounted rows");
      await verify(page);
    }
    await page.close();
  }
  }
  console.log(JSON.stringify({ chromium: browser.version(), dataset: 3000, viewport: "1200x800", results }, null, 2));
} finally {
  await browser?.close(); await server?.close(); await rm(temp, { recursive: true, force: true });
}

async function verify(page) {
  const settle = () => page.evaluate(async () => {
    for (let i = 0; i < 15; i++) await new Promise(requestAnimationFrame);
  });
  const anchor = () => page.evaluate(() => {
    const v = document.querySelector(".message-scroll-wrapper"); const top = v.getBoundingClientRect().top;
    const row = [...document.querySelectorAll(".message-row")].find((r) => r.getBoundingClientRect().bottom > top + 1);
    return { key: row?.dataset.messageKey, offset: row?.getBoundingClientRect().top - top };
  });
  const bottom = () => page.evaluate(() => {
    const v = document.querySelector(".message-scroll-wrapper"); return v.scrollHeight - v.clientHeight - v.scrollTop;
  });
  await page.evaluate(() => { window.fixture.app.autoScroll = true; }); await settle();
  assert(await bottom() <= 3, "toggle aligns bottom");
  await page.evaluate(() => window.fixture.append()); await settle();
  assert(await bottom() <= 3, "bottom arrival follows");
  await page.evaluate(() => { const v = document.querySelector(".message-scroll-wrapper"); v.scrollTop -= 1500; }); await settle();
  const reading = await anchor();
  await page.evaluate(() => window.fixture.append()); await settle();
  const after = await anchor();
  assert.equal(after.key, reading.key, "arrival while reading retains item");
  assert(Math.abs(after.offset - reading.offset) <= 3, "arrival while reading retains offset");
  await page.evaluate(() => { window.fixture.app.autoScroll = false; document.querySelector(".message-scroll-wrapper").scrollTop = 170; }); await settle();
  const beforePrepend = await anchor();
  // Dispatch without Playwright's automatic scroll-into-view, which would move
  // the reader before the action under test.
  await page.locator(".load-more-row button").evaluate((button) => button.click()); await settle();
  await page.waitForFunction(() => window.fixture.data.history[1]?.length === 200, { timeout: 3000 });
  const afterPrepend = await anchor();
  assert.equal(afterPrepend.key, beforePrepend.key, "prepend retains item");
  assert(Math.abs(afterPrepend.offset - beforePrepend.offset) <= 3, `prepend offset ${JSON.stringify({beforePrepend, afterPrepend})}`);
  if (process.env.DEBUG_LAYOUT) console.log("before format", await page.evaluate(() => {
    const instance = document.querySelector(".message-list").__vueParentComponent.setupState.virtualizer;
    const item = instance.getVirtualItemForOffset(instance.scrollOffset);
    return { scrollTop: document.querySelector(".message-scroll-wrapper").scrollTop, scrollOffset: instance.scrollOffset,
      loaded: document.querySelector(".message-list").__vueParentComponent.setupState.messages.length,
      history: window.fixture.data.history[1]?.length, more: window.fixture.data.more,
      adjustments: instance.scrollAdjustments, item: item && { key: String(item.key), start: item.start, size: item.size } };
  }));
  await page.locator(".format-toggle .el-switch").click(); await settle();
  const expandedAnchor = await anchor();
  if (process.env.DEBUG_LAYOUT) console.log("after format", await page.evaluate(() => {
    const instance = document.querySelector(".message-list").__vueParentComponent.setupState.virtualizer;
    const item = instance.getVirtualItemForOffset(instance.scrollOffset);
    return { scrollTop: document.querySelector(".message-scroll-wrapper").scrollTop, scrollOffset: instance.scrollOffset,
      adjustments: instance.scrollAdjustments, item: item && { key: String(item.key), start: item.start, size: item.size } };
  }));
  assert.equal(expandedAnchor.key, afterPrepend.key, "format change retains item");
  assert(Math.abs(expandedAnchor.offset) <= 3, `format change aligns current item ${JSON.stringify(expandedAnchor)}`);
  const heights = await page.locator(".message-row").evaluateAll((rows) => rows.map((r) => r.getBoundingClientRect().height));
  assert(Math.max(...heights) - Math.min(...heights) > 40, "JSON expansion creates measured dynamic heights");
  await page.evaluate(() => { window.fixture.data.more = true; }); await settle();
  const controlAppeared = await anchor();
  assert.equal(controlAppeared.key, expandedAnchor.key, "load-more appearance retains item");
  assert(Math.abs(controlAppeared.offset - expandedAnchor.offset) <= 3, "load-more appearance retains offset");
  await page.locator(".load-more-row button").evaluate((button) => button.click());
  await page.waitForFunction(() => window.fixture.data.history[1]?.length === 400);
  await settle();
  const expandedPrepend = await anchor();
  assert.equal(expandedPrepend.key, controlAppeared.key, "expanded variable-height prepend retains item");
  assert(Math.abs(expandedPrepend.offset - controlAppeared.offset) <= 3, "expanded variable-height prepend retains offset");
  await page.locator(".message-item").first().click();
  await page.locator(".message-detail-dialog").waitFor({ state: "visible" });
  await page.getByLabel("Close this dialog").click();
  await settle();
  const beforeResize = await anchor();
  await page.setViewportSize({ width: 520, height: 800 }); await settle();
  const narrowAnchor = await anchor();
  assert.equal(narrowAnchor.key, beforeResize.key, "width change retains item");
  assert(Math.abs(narrowAnchor.offset) <= 3, "width change aligns current item");
  assert(await page.locator(".message-row").count() < 40, "narrow layout remains bounded");
  await page.locator(".message-row").evaluateAll((rows) => {
    for (let i = 1; i < rows.length; i++) {
      const previous = rows[i - 1].getBoundingClientRect(), current = rows[i].getBoundingClientRect();
      if (Math.abs(current.top - previous.bottom) > 2) throw new Error("Measured rows overlap or have an unexpected gap");
    }
  });
  await page.locator(".message-search input").fill("payload-1"); await settle();
  assert(await page.locator(".message-row").count() > 0, "filter renders matches");
  assert(await page.evaluate(() => document.querySelector(".message-scroll-wrapper").scrollTop) < 3, "filter starts first result");
  await page.locator(".message-search input").fill(""); await settle();
  // Launch an initial fetch for server 2, return to server 1, then read upward
  // before the old server's delayed fetch completes.
  await page.evaluate(() => { window.fixture.data.delay = 400; window.fixture.app.autoScroll = true; window.fixture.server.activeServerId = 2; });
  await settle();
  assert((await page.locator(".msg-topic").first().innerText()).includes("500"), "server switch renders new server");
  await page.evaluate(() => { window.fixture.data.delay = 0; window.fixture.server.activeServerId = 1; }); await settle();
  await page.evaluate(() => { document.querySelector(".message-scroll-wrapper").scrollTop = 1500; }); await settle();
  const raceAnchor = await anchor();
  // Wait beyond the explicitly simulated history latency using browser frames.
  await page.evaluate(async () => { const start = performance.now(); while (performance.now() - start < 500) await new Promise(requestAnimationFrame); });
  const raceAfter = await anchor();
  assert.equal(raceAfter.key, raceAnchor.key, "stale initial history cannot move another server");
  assert(Math.abs(raceAfter.offset - raceAnchor.offset) <= 3, "stale history retains reader offset");
  await page.evaluate(() => { window.fixture.app.autoScroll = false; const v = document.querySelector(".message-scroll-wrapper"); v.scrollTop = v.scrollHeight; }); await settle();
  const disabledAnchor = await anchor();
  await page.evaluate(() => window.fixture.append()); await settle();
  assert.equal((await anchor()).key, disabledAnchor.key, "disabled auto-scroll does not follow at bottom");
  // Export through the real component command, inspecting only its mocked file IPC.
  await page.evaluate(async () => {
    const vm = document.querySelector(".message-list").__vueParentComponent.setupState;
    await vm.handleExportCommand("json"); await vm.handleExportCommand("csv");
  });
  const exports = await page.evaluate(() => window.fixture.data.exports);
  assert.equal(JSON.parse(exports[0]).length, 3200, "JSON export reads full history");
  assert.equal(exports[1].split("\n").length, 3201, "CSV export reads full history");
  await page.evaluate(() => { window.fixture.app.autoScroll = true; }); await settle();
  await page.evaluate(() => window.fixture.append()); await settle();
  assert(await bottom() <= 3, "expanded JSON arrivals follow through real tail measurements");
  await page.setViewportSize({ width: 1200, height: 800 }); await settle();
  assert(await bottom() <= 3, "bottom survives width reflow");
  console.log("Chromium behavior assertions passed");
}

async function verifyReviewRegressions(browser, url) {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  const settle = () => page.evaluate(async () => {
    for (let i = 0; i < 15; i++) await new Promise(requestAnimationFrame);
  });
  try {
    await page.goto(`${url}?version=after&count=1&historyFirst`);
    await page.waitForSelector(".message-row"); await settle();
    const before = await page.locator(".message-row").getAttribute("data-message-key");
    await page.evaluate(() => { window.originalHistoryRow = document.querySelector(".message-row"); });
    for (const transition of ["arrive", "replace", "disappear"]) {
      await page.evaluate((transition) => {
        const { data, rows } = window.fixture;
        data.live[1] = transition === "disappear" ? [] : rows(1).map((row) => ({ ...row, seq: 10 }));
      }, transition);
      await settle();
      assert.equal(await page.locator(".message-row").count(), 1, `${transition}: one persisted message`);
      assert.equal(await page.locator(".message-row").getAttribute("data-message-key"), before, `${transition}: history-first key retained`);
      assert(await page.evaluate(() => document.querySelector(".message-row") === window.originalHistoryRow), `${transition}: row DOM retained`);
    }
    for (const manual of [true, false]) {
      await page.goto(`${url}?version=after&count=80&autoScroll&deferInitialHistory`);
      await page.waitForSelector(".message-row"); await settle();
      if (manual) {
        await page.evaluate(() => {
          const viewport = document.querySelector(".message-scroll-wrapper");
          viewport.scrollTop = viewport.scrollHeight;
        }); await settle();
        await page.locator(".message-scroll-wrapper").hover();
        await page.mouse.wheel(0, -700); await settle();
      }
      const before = await page.evaluate(() => {
        const viewport = document.querySelector(".message-scroll-wrapper");
        return { top: viewport.scrollTop, gap: viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop };
      });
      if (manual) assert(before.gap > 400, "real wheel moved reader above bottom before completion");
      await page.evaluate(() => window.fixture.finishInitialHistory()); await settle();
      const after = await page.evaluate(() => {
        const viewport = document.querySelector(".message-scroll-wrapper");
        return { top: viewport.scrollTop, gap: viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop };
      });
      if (manual) assert(Math.abs(after.top - before.top) <= 3, `same-server delayed initial history retains manual reading ${JSON.stringify({ before, after })}`);
      else assert(after.gap <= 3, "untouched delayed initial history honors bottom preference");
    }
    console.log("Chromium review regression assertions passed");
  } finally {
    await page.close();
  }
}
