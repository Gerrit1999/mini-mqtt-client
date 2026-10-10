import { createServer } from "vite";
import vue from "@vitejs/plugin-vue";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { load } from "js-yaml";
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
  const baselineRef = process.env.BASELINE_REF ?? "0ff39c0ff530321273ee1bc92b0ba94271b0c2f0";
  const baseline = execFileSync("git", ["show", `${baselineRef}:src/components/mqtt/MessageList.vue`], { encoding: "utf8" });
  await writeFile(resolve(temp, "Baseline.vue"), baseline.replace('"./MessagePayload.vue"', '"@/components/mqtt/MessagePayload.vue"'));
  await writeFile(resolve(temp, "index.html"), '<style>html,body,#app{height:100%;margin:0}#app{height:780px}.message-list{height:100%}</style><div id="app"></div><script type="module" src="./entry.ts"></script>');
  const localeMessages = Object.fromEntries(await Promise.all(["en-US", "zh-CN"].map(async (locale) =>
    [locale, load(await readFile(resolve(root, `src/i18n/locales/${locale}.yaml`), "utf8"))])));
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
    const realLocale = new URLSearchParams(location.search).has('realLocale');
    const i18n = createI18n({legacy:false,locale:realLocale?'en-US':'en',messages:realLocale?${JSON.stringify(localeMessages)}:{},missing:(_l,k)=>k});
    window.fixture.i18n = i18n.global;
    const app = createApp(component).use(ElementPlus).use(i18n);
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
  if (process.env.LIVE_FOLLOW_FORMAT_OVERFLOW) await verifyDisabledFormatOverflow(browser, url);
  else if (process.env.LIVE_FOLLOW_DISABLED) await verifyDisabledEmptyOverflow(browser, url);
  else if (process.env.LIVE_FOLLOW_EMPTY) await verifyEmptyLiveFollow(browser, url);
  else if (process.env.LIVE_FOLLOW_STATIC) await verifyStaticLiveFollow(browser, url);
  else {
  await verifyDisabledEmptyOverflow(browser, url);
  await verifyDisabledFormatOverflow(browser, url);
  await verifyEmptyLiveFollow(browser, url);
  await verifyEmptyLiveFollow(browser, url, { gutter: true, fixedHeader: true, batches: 2 });
  await verifyStaticLiveFollow(browser, url, { count: 240, batch: 128, history: true });
  await verifyLiveFollow(browser, url);
  }
  if (!process.env.LIVE_FOLLOW_ONLY && !process.env.LIVE_FOLLOW_EMPTY && !process.env.LIVE_FOLLOW_STATIC && !process.env.LIVE_FOLLOW_DISABLED && !process.env.LIVE_FOLLOW_FORMAT_OVERFLOW) {
  await verifyReviewRegressions(browser, url);
  await verifyToolbarRegressions(browser, url);
  await verifyContentWidthRegression(browser, url);
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
    const profiler = process.env.PROFILE_DIR ? await page.context().newCDPSession(page) : undefined;
    if (profiler) {
      await profiler.send("Profiler.enable");
      await profiler.send("Profiler.start");
    }
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
    if (profiler) {
      const { profile } = await profiler.send("Profiler.stop");
      await writeFile(resolve(process.env.PROFILE_DIR, `${version}-${sample}.cpuprofile`), JSON.stringify(profile));
      await profiler.detach();
    }
    if (version === "after" && sample === 1) {
      assert(metrics.mountedRows < 40, "bounded mounted rows");
      await verify(page);
    }
    await page.close();
  }
  }
  console.log(JSON.stringify({ baselineRef, chromium: browser.version(), dataset: 3000, viewport: "1200x800", results }, null, 2));
  }
} finally {
  await browser?.close(); await server?.close(); await rm(temp, { recursive: true, force: true });
}

async function verifyDisabledFormatOverflow(browser, url) {
  const page = await browser.newPage({ viewport: { width: 532, height: 800 } });
  try {
    await page.goto(`${url}?version=after&count=1&autoScroll&emptyHistory&realLocale&receiveOnly`);
    await page.waitForSelector(".message-row");
    await page.evaluate(() => { window.fixture.data.live[1] = window.fixture.rows(1, 11); });
    await page.addStyleTag({ content: `
      #app { height: 420px; }
      .panel-header { height: 180px; }
      .message-scroll-wrapper { box-sizing: border-box; border-right: 0 solid transparent; }
      .message-scroll-wrapper:has(.message-body--expanded) { border-right-width: 6px; }
    ` });
    const sample = () => page.evaluate(async () => {
      for (let i = 0; i < 30; i++) await new Promise(requestAnimationFrame);
      const v = document.querySelector(".message-scroll-wrapper");
      return { outer: v.offsetWidth, width: v.clientWidth, height: v.clientHeight,
        extent: v.scrollHeight, top: v.scrollTop, gap: v.scrollHeight - v.clientHeight - v.scrollTop };
    });
    await sample();
    await page.locator(".toolbar-icon-action.is-active").click();
    const before = await sample();
    assert.equal(before.extent, before.height, "collapsed short content has no overflow");
    await page.locator(".format-toggle .el-switch").evaluate((s) => s.click());
    const after = await sample();
    console.log("Chromium disabled short format overflow gutter", JSON.stringify({ before, after }));
    assert.equal(after.outer, before.outer);
    assert.equal(after.width, before.width - 6);
    assert(after.extent > after.height, "explicit expansion introduces overflow");
    assert(after.gap <= 3, "disabled already-bottom explicit format overflow preserves bottom");
  } finally { await page.close(); }
}

async function verifyDisabledEmptyOverflow(browser, url) {
  const page = await browser.newPage({ viewport: { width: 532, height: 800 } });
  try {
    await page.goto(`${url}?version=after&count=0&limit=1000&autoScroll&emptyHistory&realLocale&receiveOnly`);
    await page.waitForSelector(".empty-state");
    // Match native's first-overflow 6 px gutter without changing its border box.
    await page.addStyleTag({ content: `
      .panel-header { height: 180px; }
      .message-scroll-wrapper { box-sizing: border-box; border-right: 0 solid transparent; }
      .message-scroll-wrapper:has(.message-items) { border-right-width: 6px; }
    ` });
    await page.locator(".toolbar-icon-action.is-active").click();
    const result = await page.evaluate(async () => {
      const sample = () => {
        const v = document.querySelector(".message-scroll-wrapper");
        return { outer: v.offsetWidth, width: v.clientWidth, height: v.clientHeight,
          top: v.scrollTop, gap: v.scrollHeight - v.clientHeight - v.scrollTop,
          active: !!document.querySelector(".toolbar-icon-action.is-active"),
          rows: document.querySelectorAll(".message-row").length };
      };
      for (let i = 0; i < 15; i++) await new Promise(requestAnimationFrame);
      const before = sample();
      window.fixture.append(128, 1000);
      const start = performance.now();
      while (performance.now() - start < 1000) await new Promise(requestAnimationFrame);
      return { before, after: sample() };
    });
    console.log("Chromium disabled empty first-overflow gutter", JSON.stringify(result));
    assert.equal(result.after.outer, result.before.outer, "overflow keeps outer width");
    assert.equal(result.after.width, result.before.width - 6, "overflow reserves native-sized gutter");
    assert.equal(result.after.height, result.before.height, "overflow keeps viewport height");
    assert(!result.before.active && !result.after.active && result.after.rows > 0);
    assert(Math.abs(result.after.top - result.before.top) <= 3, "disabled first arrivals retain top through overflow");
    assert(result.after.gap > 3, "disabled first arrivals do not force bottom");
  } finally { await page.close(); }
}

async function verifyEmptyLiveFollow(browser, url, options = {}) {
  const page = await browser.newPage({ viewport: { width: 528, height: 800 } });
  try {
    await page.goto(`${url}?version=${process.env.LIVE_FOLLOW_VERSION ?? "after"}&count=0&limit=1000&autoScroll&emptyHistory&realLocale&receiveOnly`);
    await page.waitForSelector(".empty-state");
    if (options.fixedHeader || process.env.LIVE_FOLLOW_FIXED_HEADER) await page.addStyleTag({ content: ".panel-header { height: 180px; }" });
    if (options.gutter || process.env.LIVE_FOLLOW_GUTTER) await page.addStyleTag({ content: `
      .message-scroll-wrapper { box-sizing: border-box; border-right: 0 solid transparent; }
      .message-scroll-wrapper:has(.message-items) { border-right-width: 6px; }
    ` });
    const results = await page.evaluate(async (batches) => {
      const samples = [];
      for (let i = 0; i < 15; i++) await new Promise(requestAnimationFrame);
      const initial = document.querySelector(".message-scroll-wrapper");
      samples.push({ batch: -1, gap: initial.scrollHeight - initial.clientHeight - initial.scrollTop,
        height: initial.clientHeight, width: initial.clientWidth, top: initial.scrollTop, received: 0, live: 0 });
      for (let batch = 0; batch < batches; batch++) {
        window.fixture.append(128, 1000);
        const start = performance.now();
        while (performance.now() - start < 300) await new Promise(requestAnimationFrame);
        const v = document.querySelector(".message-scroll-wrapper");
        samples.push({ batch, gap: v.scrollHeight - v.clientHeight - v.scrollTop,
          height: v.clientHeight, width: v.clientWidth, top: v.scrollTop,
          received: window.fixture.data.received[1], live: window.fixture.data.live[1].length });
      }
      return samples;
    }, options.batches ?? Number(process.env.LIVE_FOLLOW_BATCHES ?? 32));
    console.log("Chromium empty initial history continuous 128 arrivals", JSON.stringify(results));
    assert(results.every((r) => r.gap <= 3), "empty-to-first128 and continuous batches follow");
    assert(results.at(-1).received === (options.batches ?? Number(process.env.LIVE_FOLLOW_BATCHES ?? 32)) * 128, "receive counter is cumulative at the cap");
  } finally { await page.close(); }
}

async function verifyStaticLiveFollow(browser, url, options = {}) {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  try {
    const count = options.count ?? Number(process.env.LIVE_FOLLOW_COUNT ?? 80);
    await page.goto(`${url}?version=${process.env.LIVE_FOLLOW_VERSION ?? "after"}&count=${count}&limit=${count}&autoScroll&receiveOnly${options.history || process.env.LIVE_FOLLOW_HISTORY ? "&retainedHistory" : ""}`);
    await page.waitForSelector(".message-row");
    const sample = () => page.evaluate(async () => {
      for (let i = 0; i < 15; i++) await new Promise(requestAnimationFrame);
      const v = document.querySelector(".message-scroll-wrapper");
      const vm = document.querySelector(".message-list").__vueParentComponent.setupState;
      return { gap: v.scrollHeight - v.clientHeight - v.scrollTop, height: v.clientHeight,
        live: window.fixture.data.live[1].length, history: window.fixture.data.history[1]?.length ?? 0,
        merged: vm.filteredMessages.length, tail: window.fixture.data.live[1].at(-1).id };
    });
    await sample();
    if (!process.env.LIVE_FOLLOW_COLLAPSED) {
      await page.locator(".format-toggle .el-switch").evaluate((s) => s.click());
      await sample();
    }
    const initial = await sample();
    const batch = options.batch ?? Number(process.env.LIVE_FOLLOW_BATCH ?? 10);
    for (let step = 0; step < Math.ceil(count * 5 / batch); step++) {
      await page.evaluate(({count, batch}) => window.fixture.append(batch, count), {count, batch});
      const after = await sample();
      assert.equal(after.height, initial.height, "static viewport height remains unchanged");
      if (step % 8 === 0 || after.gap > 3) console.log("Chromium static live follow", JSON.stringify({ step, initial, after }));
      assert(after.gap <= 3, `static no-input sustained receive follows ${JSON.stringify({ step, after })}`);
    }
    await page.evaluate(async (count) => {
      for (let frame = 0; frame < count * 2; frame++) {
        window.fixture.append(frame % 4 === 0 ? 10 : 1, count);
        await new Promise(requestAnimationFrame);
      }
    }, count);
    const burst = await sample();
    console.log("Chromium static per-frame live follow", JSON.stringify({ initial, burst }));
    assert(burst.gap <= 3, "static per-frame arrivals keep following");
    for (let sparse = 0; sparse < 20; sparse++) {
      await page.evaluate((count) => window.fixture.append(1, count), count);
      const after = await sample();
      assert(after.gap <= 3, `static sparse arrival follows ${JSON.stringify(after)}`);
    }
    console.log("Chromium static sparse arrivals passed", JSON.stringify(await sample()));
    const anchor = () => page.evaluate(() => {
      const top = document.querySelector(".message-scroll-wrapper").getBoundingClientRect().top;
      const row = [...document.querySelectorAll(".message-row")].find((r) => r.getBoundingClientRect().bottom > top + 1);
      return { key: row?.dataset.messageKey, offset: row?.getBoundingClientRect().top - top };
    });
    await page.locator(".message-scroll-wrapper").hover();
    await page.mouse.wheel(0, -700);
    assert((await sample()).gap > 400, "actual wheel moves reader above bottom in capped queue");
    const reading = await anchor();
    await page.evaluate((count) => window.fixture.append(1, count), count);
    await sample();
    const afterReading = await anchor();
    assert.equal(afterReading.key, reading.key, "capped/history arrival preserves manual reader identity");
    assert(Math.abs(afterReading.offset - reading.offset) <= 3, "capped/history arrival preserves manual reader offset");
  } finally { await page.close(); }
}

async function verifyLiveFollow(browser, url) {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  try {
    await page.goto(`${url}?version=${process.env.LIVE_FOLLOW_VERSION ?? "after"}&count=80&limit=80&autoScroll&receiveOnly`);
    await page.waitForSelector(".message-row");
    const sample = () => page.evaluate(async () => {
      for (let i = 0; i < 15; i++) await new Promise(requestAnimationFrame);
      const v = document.querySelector(".message-scroll-wrapper");
      return { gap: v.scrollHeight - v.clientHeight - v.scrollTop,
        count: window.fixture.data.live[1].length,
        tail: window.fixture.data.live[1].at(-1).id, mounted: document.querySelectorAll(".message-row").length };
    });
    const initial = await sample();
    assert(initial.gap <= 3, `live follow initial bottom ${JSON.stringify(initial)}`);
    if (!process.env.LIVE_FOLLOW_MINIMAL) {
      await page.locator(".format-toggle .el-switch").click();
      await sample();
    }
    await page.evaluate(() => { document.querySelector("#app").style.height = "580px"; });
    const resized = await sample();
    console.log("Chromium no-input height shrink", JSON.stringify(resized));
    await page.evaluate((limit) => window.fixture.append(1, limit), process.env.LIVE_FOLLOW_UNCAPPED ? 20000 : 80);
    const resizedArrival = await sample();
    assert(resizedArrival.gap <= 3, `no-input arrival after viewport shrink follows ${JSON.stringify({ resized, resizedArrival })}`);
    if (process.env.LIVE_FOLLOW_MINIMAL) return;
    await page.evaluate(async () => {
      for (let frame = 0; frame < 100; frame++) {
        window.fixture.append(frame % 4 === 0 ? 10 : 1, 80);
        await new Promise(requestAnimationFrame);
      }
    });
    const burst = await sample();
    console.log("Chromium overlapping rolling arrivals", JSON.stringify(burst));
    assert(burst.gap <= 3, `no-input continuous rolling follow ${JSON.stringify(burst)}`);
    for (let step = 0; step < 20; step++) {
      await page.evaluate(() => window.fixture.append(10, 80));
      const after = await sample();
      if (step === 19) console.log("Chromium rolling expanded arrivals", JSON.stringify({ step, initial, after }));
      assert(after.gap <= 3, `no-input rolling arrival follows bottom ${JSON.stringify(after)}`);
    }
    await page.evaluate(() => { window.fixture.app.autoScroll = false; });
    for (const width of [900, 520, 1200]) {
      await page.setViewportSize({ width, height: 800 });
      const reflow = await sample();
      assert(reflow.gap <= 3, `disabled auto-scroll preserves already-bottom width reflow ${JSON.stringify(reflow)}`);
    }
    await page.locator(".format-toggle .el-switch").evaluate((s) => s.click());
    assert((await sample()).gap <= 3, "disabled auto-scroll preserves already-bottom format reflow");
    await page.evaluate(() => window.fixture.append(1, 80));
    assert((await sample()).gap > 3, "disabled arrivals do not jump to new bottom after reflow");
  } finally { await page.close(); }
}

async function verifyContentWidthRegression(browser, url) {
  const page = await browser.newPage({ viewport: { width: 900, height: 800 } });
  const geometry = () => page.evaluate(async () => {
    const viewport = document.querySelector(".message-scroll-wrapper");
    let previous, stable = 0;
    for (let frame = 0; frame < 120; frame++) {
      await new Promise(requestAnimationFrame);
      const top = viewport.getBoundingClientRect().top;
      const rows = [...document.querySelectorAll(".message-row")];
      const reading = rows.find((row) => row.getBoundingClientRect().bottom > top + 1);
      const result = { outer: viewport.offsetWidth, inner: viewport.clientWidth,
        key: reading?.dataset.messageKey, offset: reading?.getBoundingClientRect().top - top,
        heights: rows.map((row) => [row.dataset.messageKey, row.getBoundingClientRect().height]) };
      const current = JSON.stringify(result);
      stable = current === previous ? stable + 1 : 0;
      if (stable >= 4) return result;
      previous = current;
    }
    throw new Error("Content-width reflow geometry did not settle within 120 animation frames");
  });
  try {
    await page.goto(`${url}?version=after&count=600`);
    await page.waitForSelector(".message-row");
    // Headless Chromium's overlay scrollbar did not reserve space when its CSS
    // width changed. Use a controlled gutter proxy: a right border consumes
    // content space inside the fixed border box (box-sizing: border-box).
    // Assert clientWidth changes and offsetWidth stays fixed in both directions.
    await page.addStyleTag({ content: `
      .message-scroll-wrapper { box-sizing: border-box; border-right: 0 solid transparent; }
    ` });
    await page.locator(".format-toggle .el-switch").click();
    await geometry();
    await page.evaluate(() => {
      document.querySelector(".message-list").__vueParentComponent.setupState.virtualizer.scrollToIndex(149, { align: "start" });
    });
    let before = await geometry();
    assert(Math.abs(before.offset) <= 3, "mid-list expanded JSON starts aligned");
    assert(Math.max(...before.heights.map(([, height]) => height)) - Math.min(...before.heights.map(([, height]) => height)) > 40,
      "content-width regression uses expanded variable-height JSON");
    const measurements = [];
    for (const width of [304, 0]) {
      await page.evaluate((width) => {
        document.querySelector(".message-scroll-wrapper").style.borderRightWidth = `${width}px`;
      }, width);
      const after = await geometry();
      measurements.push({ border: width, before: { outer: before.outer, inner: before.inner, key: before.key, offset: before.offset },
        after: { outer: after.outer, inner: after.inner, key: after.key, offset: after.offset } });
      assert.equal(after.outer, before.outer, "gutter proxy keeps outer border-box width constant");
      assert.equal(after.inner - before.inner, width === 304 ? -304 : 304, "gutter proxy changes actual clientWidth in both directions");
      const oldHeights = new Map(before.heights);
      assert(after.heights.some(([key, height]) => oldHeights.has(key) && Math.abs(height - oldHeights.get(key)) > 10),
        "content-width change rewraps a measured row");
      before = after;
    }
    // Collect both directions before checking anchors so a failure still
    // reports the full width transition, rather than hiding the reverse leg.
    console.log("Chromium constant-outer-width gutter proxy measurements", JSON.stringify(measurements));
    for (const { border, before, after } of measurements) {
      assert.equal(after.key, before.key, `gutter proxy width ${border} retains reading item ${JSON.stringify(measurements)}`);
      assert(Math.abs(after.offset) <= 3, `gutter proxy width ${border} aligns reading item ${JSON.stringify(measurements)}`);
    }
    console.log("Chromium constant-outer-width gutter proxy regression passed", JSON.stringify(measurements));
  } finally {
    await page.close();
  }
}

async function verifyToolbarRegressions(browser, url) {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  const settle = () => page.evaluate(async () => {
    for (let i = 0; i < 15; i++) await new Promise(requestAnimationFrame);
  });
  try {
    await page.goto(`${url}?version=after&count=80&realLocale`);
    await page.waitForSelector(".message-row"); await settle();
    assert.equal(await page.locator(".message-search input").getAttribute("placeholder"), "Search messages...");
    const topic = await page.evaluate(() => window.fixture.data.live[1][0].topic);
    const input = page.locator(".topic-filter input");
    await input.fill(topic);
    await page.locator(".el-select-dropdown__item:visible").filter({ hasText: topic }).click();
    await page.locator(".panel-title").click(); await settle();
    assert.equal(await page.locator(".message-row").count(), 1, "Topic selection filters rows");
    assert.equal(await page.locator(".topic-text").innerText(), topic);
    await page.evaluate(() => {
      const { data, rows, i18n, app } = window.fixture;
      data.live[1].push({ ...rows(1, 100)[0], topic: "new/topic" });
      i18n.locale.value = "zh-CN";
      app.locale = "zh-CN";
    }); await settle();
    assert.equal(await page.locator(".message-row").count(), 1, "arrival retains Topic selection");
    assert.equal(await page.locator(".message-search input").getAttribute("placeholder"), "搜索消息...");
    assert.equal(await page.locator(".format-toggle-label").innerText(), "JSON格式化");
    assert.equal(await page.locator(".msg-time").innerText(), await page.evaluate(() => {
      const date = new Date(window.fixture.data.live[1][0].timestamp);
      return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" }) + "." + date.getMilliseconds().toString().padStart(3, "0");
    }), "row time follows locale");
    await page.locator(".topic-filter").hover();
    await page.locator(".topic-filter .el-select__clear").click(); await settle();
    assert(await page.locator(".message-row").count() > 1, "Topic clear restores rows");
    await input.fill("new/topic");
    await page.locator(".el-select-dropdown__item:visible").filter({ hasText: "new/topic" }).click();
    await page.locator(".panel-title").click(); await settle();
    assert.equal(await page.locator(".topic-text").innerText(), "new/topic", "new option is selectable");
    await page.evaluate(() => { window.fixture.data.live[1] = window.fixture.data.live[1].filter((row) => row.topic !== "new/topic"); });
    await settle();
    await page.locator(".topic-filter").hover();
    await page.locator(".topic-filter .el-select__clear").click();
    await input.fill("new/topic"); await settle();
    assert.equal(await page.locator(".el-select-dropdown__item:visible").count(), 0, "removed topics leave options");
    await page.evaluate(() => { window.fixture.i18n.locale.value = "en-US"; }); await settle();
    assert.equal(await page.locator(".message-search input").getAttribute("placeholder"), "Search messages...");
    console.log("Chromium Topic and real locale regression assertions passed");
  } finally {
    await page.close();
  }
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
