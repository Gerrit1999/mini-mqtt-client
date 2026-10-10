# Main fixes: audit, message search and virtual scrolling

Measured on 2026-10-10 on main, starting at `df84b5aaae2479287803bf12dea7ecfb3bc078d5`.
The exploratory tables describe successive candidates. The final content-width
correction and complete validation are reported separately below.

## Changes and diagnosis

Message search now uses `messages.search.placeholder`: “Search messages...” / “搜索消息...”.
Template wording is retained elsewhere. Dedicated browser regressions load the actual YAML locales;
performance pages retain the original untranslated-label setup.

Ranked hypotheses before experiments:

1. Parent scrolling enumerates 3,000 Topic options despite individual option memoization.
   Prediction: isolating the existing select's render should remove that work without dropping options.
2. Visible row Vue/Element Plus/payload churn.
   Prediction: profiling should identify repeated reusable row work.
3. Post-render geometry measurements force layout.
   Prediction: measured-library anchor lookup should reduce hook cost without breaking anchoring/reflow.

The pre-upgrade CPU profile showed the post-update hook at **317.258 ms** inclusive,
and `formatTime` at **169.031 ms** across the sweep. First, a 24-line Topic child
render boundary isolated the complete select. This modestly reduced slow-frame counts in
exploratory paired samples but did not remove the issue. The next one-variable step reused
a reactive `Intl.DateTimeFormat` instead of rebuilding locale formatting on each scroll render.
The next step replaced the post-update DOM rectangle scan with the virtualizer's existing
measured `getVirtualItemForOffset(scrollOffset + 1)`.

Before the final content-width correction, the same-dependency candidate profile
showed post-update hook CPU **279.715 → 3.243 ms**
and `formatTime` **155.913 → 10.843 ms**. Layout and repeated locale formatting were
confirmed costs. Row render work remains. An additional independent Topic-boundary
control held those two fixes and upgraded dependencies constant: slow frames without/with
the child were 24/14, 3/14, 7/20. It showed no stable benefit, so the child component
was removed. The final source retains the original select and individual option memoization.

Actual measured heights, `_willUpdate()`, overscan, options, controls, tags, payloads,
identity and scroll policies are retained. The final anchor guard reads the viewport's
clientWidth once and compares it to the committed content width; TanStack's border-box
width alone cannot detect content-only changes. Row lookup uses measured library geometry.
No component abstraction or toolbar memo guard was introduced in the final source.
Locale changes rebuild the formatter. Invalid dates retain the previous “Invalid Date” output.

## Content-only width reflow

A follow-up regression reproduced an existing main defect with expanded JSON:
the outer width remained **898 px**, while content width changed **898 → 594 → 898 px**.
Narrowing moved the reader from key 150 at offset 0 to key 165 at offset −211 px.
Both the original `df84b5a` source and the first performance candidate failed.

`measure()` resets cached heights. Vue's `nextTick()` completes before row
ResizeObservers and pending scroll compensation settle, so restoring an absolute
index immediately can be displaced. The correction waits one animation frame before
restoring the index and checks the layout generation afterward. The content-width guard
preserves the last committed reading key without reinstating per-row rectangle scans.
With the correction, key 150 stays at offset **0 px in both directions**.

The browser test asserts unchanged outer width, changed clientWidth, actual row
rewrapping, retained identity and top alignment. It waits for stable RAF geometry.
Headless overlay scrollbars did not reserve space under custom scrollbar styling;
the test therefore uses a documented 304 px right-border proxy inside a fixed border
box. This is a controlled content-width stress case, not native scrollbar validation.

## Workload and reproduction

Chromium **146.0.7680.177**, Playwright **1.64.0**. Same 3,000 variable-height messages
and unique Topics, 120 RAF scroll steps, >32 ms threshold, 1200×800 viewport, 780 px app height.
Each timed page initially mounts 16 message rows and has 6,462 document elements.
No concurrent worker test/build jobs ran during benchmarks; existing application/broker
processes were left alone. Host timing varies, including against the prior report.

```sh
npm ci
PLAYWRIGHT_MODULE=/tmp/issue31-playwright/node_modules/playwright/index.mjs \
BASELINE_REF=df84b5aaae2479287803bf12dea7ecfb3bc078d5 \
  node scripts/verify-message-list.mjs
mkdir -p /tmp/mini-mqtt-profile-final
PLAYWRIGHT_MODULE=/tmp/issue31-playwright/node_modules/playwright/index.mjs \
BASELINE_REF=df84b5aaae2479287803bf12dea7ecfb3bc078d5 \
BENCHMARK_SAMPLES=1 PROFILE_DIR=/tmp/mini-mqtt-profile-final \
  node scripts/verify-message-list.mjs
```

The default baseline remains `0ff39c0ff530321273ee1bc92b0ba94271b0c2f0`.
BASELINE_REF overrides the SFC read with git show; both sides share the installed dependencies.
Only the extracted baseline's MessagePayload import is redirected. PROFILE_DIR saves CDP CPU
profiles after mounting and before the sweep. Profiling changes frame scheduling, so profile
counts cannot be compared directly with unprofiled counts.

## All samples

Numbers preserve raw runner floating-point values. Every row represents 120 frames,
16 mounted rows and 6,462 document elements. Render overlap intersects long tasks
with the mount window; scroll task ms sums tasks starting in the sweep.

- original: original dependencies and unchanged df84b5a on both sides, CPU profiling enabled.
- isolated: original dependencies, Topic boundary alone. A placeholder edit caused HMR during
  this exploratory run; it is retained transparently and excluded from final conclusions.
- formatter: original dependencies, Topic boundary plus reusable formatter.
- layout: original dependencies, additionally uses measured-library anchor lookup.
  Original browser behavior assertions passed before dependency upgrades.
- final: upgraded dependencies, df84b5a versus the candidate including the Topic child, profiling disabled.
  This separates source improvement from dependency upgrades.
- final-profile: same upgraded dependencies/candidate source, CPU profiling enabled.
- topic-control: upgraded dependencies, both sides have the retained geometry/time fixes;
  before uses the original inline select, after uses the child. No production source
  changed during this control. Temporary runner baseline loading was restored byte-for-byte.
- pre-anchor-fix: source after removing the unsupported child, before the content-only
  reflow correction, paired against df84b5a with upgraded dependencies, profiling disabled.

| Run | Sample | Version | Mount ms | Frames >32 ms | Max frame ms | Render tasks | Render overlap ms | Scroll tasks | Scroll task ms |
| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| original | 1 | before | 1446.5 | 47 | 63.200000047683716 | 1 | 1435.1000000238419 | 11 | 652 |
| original | 1 | after | 1881.5 | 39 | 60.5 | 1 | 1868.2999999523163 | 5 | 277 |
| original | 2 | before | 1713.7000000476837 | 23 | 78.39999997615814 | 1 | 1696.1000000238419 | 1 | 78 |
| original | 2 | after | 1775.6000000238419 | 17 | 68.89999997615814 | 1 | 1764.2000000476837 | 1 | 57 |
| original | 3 | before | 1649 | 36 | 67.5 | 1 | 1629.3000000715256 | 11 | 652 |
| original | 3 | after | 1599.7999999523163 | 34 | 62.59999990463257 | 1 | 1586.5999999046326 | 4 | 231 |
| isolated | 1 | before | 5168.799999952316 | 58 | 104.40000009536743 | 1 | 5148.299999952316 | 11 | 714 |
| isolated | 1 | after | 2538.5 | 44 | 87.10000002384186 | 1 | 2522.100000023842 | 9 | 532 |
| isolated | 2 | before | 2058.399999976158 | 36 | 63.59999990463257 | 1 | 2042.6999999284744 | 5 | 281 |
| isolated | 2 | after | 2064.2999999523163 | 28 | 66.29999995231628 | 1 | 2045.8999999761581 | 1 | 50 |
| isolated | 3 | before | 1742.3999999761581 | 32 | 66.89999997615814 | 1 | 1729.5 | 2 | 126 |
| isolated | 3 | after | 2639.100000023842 | 29 | 73.90000009536743 | 1 | 2626.399999976158 | 3 | 193 |
| formatter | 1 | before | 1898.1999999284744 | 25 | 69.09999990463257 | 1 | 1886.2999999523163 | 1 | 68 |
| formatter | 1 | after | 1526.8999999761581 | 24 | 64.20000004768372 | 1 | 1513.6999999284744 | 1 | 89 |
| formatter | 2 | before | 1480.3999999761581 | 22 | 64.19999992847443 | 1 | 1467 | 1 | 58 |
| formatter | 2 | after | 1669.7000000476837 | 21 | 60.89999997615814 | 1 | 1656.1000000238419 | 1 | 59 |
| formatter | 3 | before | 1933.6999999284744 | 26 | 71.19999992847443 | 1 | 1921.1999999284744 | 1 | 62 |
| formatter | 3 | after | 1583.6999999284744 | 14 | 64.5 | 1 | 1570.5 | 1 | 56 |
| layout | 1 | before | 1488.7999999523163 | 23 | 53.299999952316284 | 1 | 1476.2999999523163 | 1 | 90 |
| layout | 1 | after | 1487.2999999523163 | 9 | 56 | 1 | 1474.3999999761581 | 0 | 0 |
| layout | 2 | before | 1671 | 21 | 72.29999995231628 | 1 | 1657.1000000238419 | 1 | 67 |
| layout | 2 | after | 1542.9000000953674 | 6 | 53.199999928474426 | 1 | 1531.2000000476837 | 0 | 0 |
| layout | 3 | before | 1570.6000000238419 | 24 | 68.29999995231628 | 1 | 1556.8999999761581 | 2 | 102 |
| layout | 3 | after | 2111.2999999523163 | 11 | 38.699999928474426 | 1 | 2098.100000023842 | 0 | 0 |
| final | 1 | before | 1430.8000000715256 | 38 | 58 | 1 | 1418.5 | 6 | 364 |
| final | 1 | after | 1514.2999999523163 | 7 | 78.89999997615814 | 1 | 1500.3999999761581 | 1 | 76 |
| final | 2 | before | 1955.0999999046326 | 34 | 69.09999990463257 | 1 | 1942.6999999284744 | 4 | 282 |
| final | 2 | after | 2095.5 | 10 | 81.40000009536743 | 1 | 2081.399999976158 | 1 | 83 |
| final | 3 | before | 1514.3999999761581 | 24 | 62.300000071525574 | 1 | 1501.5 | 0 | 0 |
| final | 3 | after | 1729.6000000238419 | 9 | 53.800000071525574 | 1 | 1715.6999999284744 | 0 | 0 |
| final-profile | 1 | before | 1462.3000000715256 | 20 | 70.79999995231628 | 1 | 1452.2000000476837 | 2 | 129 |
| final-profile | 1 | after | 1462.5999999046326 | 6 | 80.09999990463257 | 1 | 1449.7999999523163 | 1 | 80 |
| topic-control | 1 | before | 1709.5 | 24 | 69.59999990463257 | 1 | 1697.6999999284744 | 3 | 192 |
| topic-control | 1 | after | 1525.3000000715256 | 14 | 58.200000047683716 | 1 | 1508.3999999761581 | 1 | 82 |
| topic-control | 2 | before | 1474 | 3 | 52.59999990463257 | 1 | 1460 | 0 | 0 |
| topic-control | 2 | after | 1590.9000000953674 | 14 | 53.299999952316284 | 1 | 1568.9000000953674 | 0 | 0 |
| topic-control | 3 | before | 1744.8000000715256 | 7 | 96.5 | 1 | 1731.3000000715256 | 1 | 92 |
| topic-control | 3 | after | 1498.4000000953674 | 20 | 57.39999997615814 | 1 | 1487.6000000238419 | 0 | 0 |
| pre-anchor-fix | 1 | before | 1507.6999999284744 | 12 | 58.5 | 1 | 1494.3999999761581 | 0 | 0 |
| pre-anchor-fix | 1 | after | 1614.8999999761581 | 8 | 68.59999990463257 | 1 | 1603 | 1 | 71 |
| pre-anchor-fix | 2 | before | 1608.5 | 17 | 59.90000009536743 | 1 | 1597 | 1 | 59 |
| pre-anchor-fix | 2 | after | 1593.7999999523163 | 5 | 51.39999997615814 | 1 | 1583 | 0 | 0 |
| pre-anchor-fix | 3 | before | 1576.7000000476837 | 9 | 57.39999997615814 | 1 | 1565.2999999523163 | 0 | 0 |
| pre-anchor-fix | 3 | after | 1521.5999999046326 | 9 | 61.40000009536743 | 1 | 1507.5999999046326 | 2 | 103 |

Pre-anchor-fix slow-frame counts: **12/17/9 → 8/5/9** (38 → 22 total).
Maximum frame time worsened in samples 1 and 3, and scroll long tasks were 0/1/0 → 1/0/2.
Mount times also vary. The evidence supports reduced sampled slow-frame counts and
lower profiled geometry/formatting work, not better worst-case latency, fewer long
tasks, faster mount, zero slow frames or platform-wide claims.

This is a real Chromium **component fixture**, mocking stores/Tauri IPC; it does not
measure native MQTT delivery, SQLite, Windows or WebView behavior. Raw logs/profiles:
`/tmp/mini-mqtt-perf-*.json`, `/tmp/mini-mqtt-profile-before/*.cpuprofile`,
`/tmp/mini-mqtt-profile-final/*.cpuprofile`, `/tmp/mini-mqtt-profile-summary.json`.
Those artifacts are session-local; the tables preserve all samples.

## Dependency resolution and audit

Original full audit: **28 total (21 high, 7 moderate)**. Final full audit:
**4 total, all high**. Final `npm audit --omit=dev`: **0** vulnerabilities.
The prior production audit had 7 high. Full audit exits 1 for the residual chain;
production audit exits 0. Audit/registry data was checked on 2026-10-10 and may change.

Residual development chain (all four records fixAvailable=false):

`@intlify/unplugin-vue-i18n@11.0.3 → fast-glob@3.3.3 → micromatch@4.0.8 → braces@3.0.3`

[The braces advisory](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) has no patched
release; registry latest stable major-3 remains 3.0.3. These are four affected package
records from one chain. No replacement implementation or incompatible override was added.

[The Vue SSR advisory](https://github.com/advisories/GHSA-g2v6-rqmx-r4w6) is patched
in 3.5.42; installed Vue is 3.5.43. An installed SSR dependency advisory alone does not
establish exploitability in this desktop client.

Targeted npm update reproduced the existing Arborist edgesOut crash, including in a clean
temporary directory. To preserve unaffected locks, affected versions/tarball URLs/integrities/
dependency metadata were seeded from the [npm registry](https://registry.npmjs.org/).
Coherent Vue/Vitest/Intlify/Rollup families moved together. Then
`npm install --package-lock-only --ignore-scripts --no-audit` reconciled their necessary
dependency closure in that temporary directory. The resulting lock passed workspace
`npm ci --ignore-scripts --no-audit`.

That closure updates Babel/entities for Vue, HumanFS core/types for patched HumanFS node,
and balanced-match for minimatch's published brace-expansion requirement. The transitive
brace-expansion major change is an upstream compatible requirement, not an override.
A focused test caught lodash-es 4.18.0's fromPairs publication defect; lodash and lodash-es
were moved to 4.18.1 and checks rerun. No force audit fix or framework-major migration was used.

Tauri and TanStack lock entries were verified byte-equivalent to HEAD. TanStack Vue Virtual
remains **3.13.39**, virtual-core **3.17.11**. Unaffected direct packages retain their versions.
Changed versions below omit repetitive Rollup platform packages, all moving 4.55.1 → 4.59.0.

| Lock path (under node_modules) | Before | After |
| --- | --- | --- |
| @babel/helper-string-parser | 7.27.1 | 7.29.7 |
| @babel/helper-validator-identifier | 7.28.5 | 7.29.7 |
| @babel/parser | 7.28.6 | 7.29.9 |
| @babel/types | 7.28.6 | 7.29.8 |
| @eslint/config-array/node_modules/brace-expansion | 1.1.12 | 1.1.21 |
| @eslint/config-array/node_modules/minimatch | 3.1.2 | 3.1.4 |
| @eslint/eslintrc/node_modules/brace-expansion | 1.1.12 | 1.1.21 |
| @eslint/eslintrc/node_modules/minimatch | 3.1.2 | 3.1.4 |
| @humanfs/core | 0.19.1 | 0.19.2 |
| @humanfs/node | 0.16.7 | 0.16.8 |
| @humanfs/types | absent | 0.15.0 |
| @intlify/vue-i18n-extensions/node_modules/@intlify/core-base | 10.0.7 | 10.0.8 |
| @intlify/vue-i18n-extensions/node_modules/@intlify/message-compiler | 10.0.7 | 10.0.8 |
| @intlify/vue-i18n-extensions/node_modules/vue-i18n | 10.0.7 | 10.0.8 |
| @vitest/expect | 4.1.6 | 4.1.11 |
| @vitest/mocker | 4.1.6 | 4.1.11 |
| @vitest/pretty-format | 4.1.6 | 4.1.11 |
| @vitest/runner | 4.1.6 | 4.1.11 |
| @vitest/snapshot | 4.1.6 | 4.1.11 |
| @vitest/spy | 4.1.6 | 4.1.11 |
| @vitest/utils | 4.1.6 | 4.1.11 |
| @vue/compiler-core | 3.5.26 | 3.5.43 |
| @vue/compiler-dom | 3.5.26 | 3.5.43 |
| @vue/compiler-sfc | 3.5.26 | 3.5.43 |
| @vue/compiler-ssr | 3.5.26 | 3.5.43 |
| @vue/reactivity | 3.5.26 | 3.5.43 |
| @vue/runtime-core | 3.5.26 | 3.5.43 |
| @vue/runtime-dom | 3.5.26 | 3.5.43 |
| @vue/server-renderer | 3.5.26 | 3.5.43 |
| @vue/shared | 3.5.26 | 3.5.43 |
| ajv | 6.12.6 | 6.14.0 |
| brace-expansion | 2.0.2 | 5.0.12 |
| brace-expansion/node_modules/balanced-match | absent | 4.0.4 |
| entities | 7.0.0 | 7.0.1 |
| eslint/node_modules/brace-expansion | 1.1.12 | 1.1.21 |
| eslint/node_modules/minimatch | 3.1.2 | 3.1.4 |
| flatted | 3.3.3 | 3.4.2 |
| immutable | 5.1.4 | 5.1.8 |
| js-cookie | 3.0.5 | 3.0.6 |
| js-yaml | 4.1.1 | 4.3.2 |
| lodash | 4.17.21 | 4.18.1 |
| lodash-es | 4.17.22 | 4.18.1 |
| micromatch/node_modules/picomatch | 2.3.1 | 2.3.2 |
| minimatch | 9.0.5 | 9.0.7 |
| nanoid | 3.3.11 | 3.3.20 |
| picomatch | 4.0.3 | 4.0.4 |
| postcss | 8.5.6 | 8.5.29 |
| rollup | 4.55.1 | 4.59.0 |
| source-map-js | 1.2.1 | 1.2.2 |
| undici | 7.25.0 | 7.29.1 |
| vite | 6.4.1 | 6.4.4 |
| vitest | 4.1.6 | 4.1.11 |
| vue | 3.5.26 | 3.5.43 |
| yaml | 2.8.2 | 2.8.3 |

Audit artifacts: `/tmp/mini-mqtt-fix-main-audit-before.json`,
`/tmp/mini-mqtt-fix-main-audit-after.json`,
`/tmp/mini-mqtt-fix-main-audit-production-after.json`.

## Preliminary checks

- `npx vitest run src/components/mqtt/MessageList.test.ts src/components/mqtt/MessagePayload.test.ts src/i18n src/stores/app.locale.test.ts`:
  **60 passed, 5 files**, Vitest 4.1.11.
- `npm run build`: TypeScript and Vite build passed; existing large-chunk warning remains.
- Final Chromium behavior assertions passed: prepend/expanded JSON/width alignment,
  bottom follow/manual intent, stable identity, filters, full-history JSON/CSV export,
  delayed requests and server switches.
- Added browser checks passed: actual en-US/zh-CN message placeholders, locale-dependent
  row time/toolbar labels, Topic selection/clear, arrival while selected, new option
  selection, removed option disappearance, switching back to English.
- Changed-file whitespace checks include this document. The exploratory component was deleted.

## Final validation

- `npm ci --no-audit`: clean installation passed with package lifecycle scripts enabled.
- `npm test -- --run`: **258 passed, 1 skipped**; 29 passed files and one skipped benchmark file.
- Runtime-only i18n checks: **26 passed across 4 files**.
- `cargo test`: **76 passed, 1 ignored**; no failures.
- `npm run tauri -- build --debug --no-bundle`: type check, production frontend and Linux desktop build passed.
- `node scripts/i18n-bundle-report.mjs`: runtime-only i18n retained; no YAML parser modules;
  `baseCompile` and `createParser` exports remain removed. Existing chunk-size warning remains.
- Final production audit: **0**; complete audit: **4 high**, the documented unpatched development chain.
- Real native desktop harness: **14 checks passed**, including MQTT 3.1.1/5.0 with
  text/binary QoS 0/1/2, persisted history, CRUD, filtering/detail, scheduled stop,
  script/env cache invalidation, locale/theme restart and close flushing.
  Results: `/tmp/mini-mqtt-native-validation/run-20261010-093440/results.json`.
- Chromium review, toolbar/real-locale, content-width and complete behavior regressions passed.
  Final content-width measurements retained key 150 at offset 0 through **898 → 594 → 898 px**.
  Final runner log: `/tmp/mini-mqtt-main-final-browser.log`.

The final three-sample comparison used the same upgraded dependencies and the original
`df84b5a` virtualized source as baseline. Each row represents the unchanged 3,000-message,
120-frame workload, with 16 mounted rows and 6,462 document elements. These measurements
include the content-width correction and its single viewport width read; the earlier
3.243 ms hook profile does not describe this final guard.

| Sample | Version | Mount ms | Frames >32 ms | Max frame ms | Render overlap ms | Scroll tasks | Scroll task ms |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | Before | 1501.3000000715256 | 21 | 58.700000047683716 | 1484.1000000238419 | 0 | 0 |
| 1 | After | 1640.0999999046326 | 16 | 67.30000007152557 | 1628.5 | 1 | 62 |
| 2 | Before | 1619.1999999284744 | 18 | 65.60000002384186 | 1608.1999999284744 | 0 | 0 |
| 2 | After | 1458 | 16 | 56.60000002384186 | 1446.5 | 1 | 54 |
| 3 | Before | 1564.1000000238419 | 30 | 72.60000002384186 | 1553.1000000238419 | 2 | 110 |
| 3 | After | 2251.2999999523163 | 19 | 60.299999952316284 | 2234.899999976158 | 2 | 113 |

Slow frames fell in each sample, **21/18/30 → 16/16/19**, or **69 → 51 total**.
Mount medians were **1564.1000000238419 → 1640.0999999046326 ms**; scroll long tasks
increased **2 → 4**. Sample 1's maximum frame also worsened. The final evidence supports
fewer sampled slow frames and corrected content-width anchoring, not faster initial
rendering, uniformly lower latency, zero slow frames or fewer long tasks.

Native validation used Linux GTK/WebKitGTK and a local broker, without store/IPC mocks.
Windows, TLS/auth/proxy/WebSocket, packaging/updater installation and native-dialog exports
were not exercised in this run. Chromium component performance uses the documented mocks.
