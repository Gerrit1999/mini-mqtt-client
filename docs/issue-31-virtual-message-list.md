# Issue #31: virtual message list

## Implementation and policies

`MessageList.vue` uses exactly `@tanstack/vue-virtual@3.13.39`, whose installed
dependency is `@tanstack/virtual-core@3.17.11`. The released adapter source and
core typings/source were inspected, including `measureElement`, `getItemKey`,
`anchorTo`, `followOnAppend`, `scrollToEnd`, and `measure`. See the official
[Vue adapter documentation](https://tanstack.com/virtual/latest/docs/framework/vue/vue-virtual)
and [virtualizer API](https://tanstack.com/virtual/latest/docs/api/virtualizer).

- Only viewport rows plus six rows of overscan on each side mount. The initial
  estimate is 88 px. The library measures actual wrapper border-box heights and
  observes subsequent changes. The existing 4 px spacing remains wrapper
  padding, included in measurement. Rows use absolute positioning inside a sizer.
  Stable Topic options use Vue's `v-memo` so virtualizer updates do not rebuild
  unchanged option components. New topics still update the select.
- `anchorTo: "end"` preserves the first visible item's position on prepend and
  corrects estimates as rows acquire real heights. Native browser anchoring is
  disabled to avoid applying two corrections. The load-more control is measured
  separately as `paddingStart` and deducted from the message sizer so it is
  counted once in the total scroll extent; its appearance/disappearance compensates the
  reader's offset. The Vue adapter updates before rendering, so `onUpdated`
  completes its typed `_willUpdate()` lifecycle after the sizer commits. This
  lifecycle integration is covered by the pinned-release browser checks.
- `followOnAppend` is enabled only with auto-scroll and a live-stream tail
  (history-only arrivals cannot trigger live follow). The library checks whether
  the viewport was within 2 px of the bottom **before** changing items. Readers
  above the bottom stay put. The unconditional native flush-event scroll was
  removed. Enabling auto-scroll explicitly moves to the latest message;
  disabling it preserves the current position.
- A changed search, Topic selection, or direction starts at the first matching
  result. Filters persist across servers, matching the existing control state.
  A server switch closes details and starts at the top; successful initial
  history aligns bottom when auto-scroll is enabled and the user has not
  superseded that preference with wheel, touch, scrollbar, or scroll-key input
  during the request. Request generations and
  active-server checks prevent a stale initial fetch from moving another server
  or overriding a later filter/reflow. Load-more completion issues no custom
  scroll command: anchoring applies to the current view when its data arrives.
- Width or JSON-format changes discard stale cached sizes, retain the reading
  item, and align its top so its full content is visible. A view already at the
  bottom remains there. The last committed width's item is remembered because
  row resize notifications can precede viewport resize notification. There are
  no polling loops or application scrolling timers.

`messageIdentity.ts` separates persistence deduplication from render identity.
Aliases contain the server and the distinct operation/id namespace, encoded as
JSON tuples without delimiter ambiguity. Live sequence identities use their own
server/seq namespace, and anonymous objects receive process-unique transient
tokens through a WeakMap. No array index, topic, timestamp or payload is a key.
Identical unpersisted arrivals remain distinct. A history-first persisted row
retains its established key when its live counterpart arrives, is replaced,
or disappears. Assigning an id or replacing a live-first object retains its
session identity, including when history registered that id afterward. Sequence
aliases remember these choices across object replacement without deduplicating
by sequence or content.
SQLite id and operation aliases deduplicate the same persisted record, including
received history rows. Alias retention is bounded by currently loaded records;
object caches use WeakMaps. History conversion is cached by source object to keep
anonymous loaded history stable. Existing historical-prefix/live-seq ordering
and advanced publish-status selection remain intact.

The same row body, MessagePayload, detail dialog, subscription colors, errors,
copy actions, search encodings and control operations remain in production.
JSON/CSV export still calls `fetchAllMessageHistory(server)` and applies the
existing filters to complete history, independently of mounted rows. No Rust,
protocol, schema, persistence, or store implementation changes were made.

## Reproduction

From this worktree's root:

```sh
npm ci
npm test
npm run build
npm install --prefix /tmp/issue31-playwright --no-package-lock playwright@1.64.0
PLAYWRIGHT_MODULE=/tmp/issue31-playwright/node_modules/playwright/index.mjs \
  node scripts/verify-message-list.mjs
```

`CHROMIUM_PATH` optionally overrides `/usr/bin/chromium`.
`BENCHMARK_SAMPLES` optionally overrides three samples (use `1` for a quick
behavior check). Run the benchmark without other validation jobs for less host
contention. The driver is installed outside the repository and is not a new
project dependency.

The script starts an ephemeral loopback Vite server and actual headless Chromium.
It extracts the **real baseline MessageList.vue** with `git show` from
`0ff39c0ff530321273ee1bc92b0ba94271b0c2f0`, changing only its relative
MessagePayload import to point to the unchanged production component. It loads
baseline and changed SFCs with the same Vue, Element Plus, CSS and dataset.
Generated baseline/entry files and the server/browser are removed/closed in
`finally`, including assertion failures.

`scripts/issue31-fixture.ts` explicitly **mocks stores, Tauri file IPC and history**.
Its reactive data drives real production components and the installed virtualizer;
it does not measure native persistence, MQTT delivery or Windows/WebView behavior.
Browser fixture control and Vue's existing component instance are used without
adding production test hooks.

The dataset has 3,000 live messages, monotonic live seq, 17 topic prefixes with
unique long topic suffixes, variable text lengths, JSON arrays of different
lengths, publish status and script errors. Both versions begin collapsed at
1200 x 800 with the same 780 px app height. Each sample uses a fresh browser page.
The benchmark samples all mounted `.message-row` elements and all document
elements once initial rendering is ready. Elapsed rendering runs from immediately
before `app.mount` through two animation frames. Scrolling sets scrollTop to 120
evenly spaced positions from first to last over 120 requestAnimationFrame steps.
Frame intervals over 32 ms and maximum intervals are scheduling indicators;
long tasks are entries over 50 ms from PerformanceObserver. Render long-task ms
is the intersection of those task intervals with the measured render window;
scroll long-task counts/ms cover tasks starting during the scrolling window.

Behavior assertions exercise bottom/away arrivals, enabled/disabled auto-scroll,
real 200-row history insertions, load-more disappearance and appearance, a second
prepend with expanded variable-height JSON, format and width remeasurement,
adjacent row geometry, detail opening, narrow 520 px and wide 1200 px widths,
long topics/payloads, search reset, active-server transitions, delayed initial
history completion, full-history JSON/CSV export, and expanded JSON tail follow.
Additional review regressions assert history-first/live transition keys and
actual row DOM retention, a real upward wheel scroll during a controlled
same-server pending request, and untouched delayed initial bottom alignment.

## Validation and results

Parent final Linux development-container validation on 2026-10-09, after both
review fixes:

- `npm test`: **258 passed**, one opt-in receive benchmark skipped; 29 passing
  files and one skipped file. Added regressions cover identity namespaces,
  anonymous repeats, id assignment/object replacement, history/live dedup,
  advanced publish status, actual bounded production row mounting, delayed
  history/server/filter races, search modes, and memoized Topic-option updates.
- `npm run build`: TypeScript checks and Vite production build passed. The
  existing large-chunk warning remains.
- Actual Chromium **146.0.7680.177**, Playwright **1.64.0**: all browser behavior
  assertions passed. The three-sample benchmark uses the final production SFC.
- Complete changed-file whitespace checks include untracked new files.

Focused review-fix validation reproduced both failures before correction:
the history-first unit regression changed `[1,"id",42]` to `[1,"seq",10]`, and
the component regression observed an unwanted `scrollToEnd` call. Chromium
independently observed `[1,"id",1]` becoming `[1,"seq",10]`; after the identity
fix alone, delayed completion moved a real wheel reader from scrollTop 5487 to
6170 (bottom gap 683 to 0). After both fixes, all 42 identity/component tests
and a `BENCHMARK_SAMPLES=1` Chromium run passed, including the existing behavior
checks. `npm run build` passed TypeScript and Vite checks; tracked and new-file
whitespace checks passed. This focused run does not replace the three-sample
results below.

Changed files: `src/components/mqtt/MessageList.vue`, its `MessageList.test.ts`,
`src/utils/messageIdentity.ts` and its test, `package.json`, `package-lock.json`,
`scripts/issue31-fixture.ts`, `scripts/verify-message-list.mjs`, and this document.

Benchmark results follow (times rounded to 0.1 ms; counts are exact).

| Sample | Version | Mounted rows | Document elements | Render ms | Render long tasks | Render long-task overlap ms |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| 1 | Before | 3,000 | 68,465 | 4,137.3 | 3 | 4,123.2 |
| 1 | After | 16 | 6,462 | 1,401.1 | 1 | 1,390.8 |
| 2 | Before | 3,000 | 68,465 | 4,322.2 | 3 | 4,309.5 |
| 2 | After | 16 | 6,462 | 1,438.3 | 1 | 1,427.6 |
| 3 | Before | 3,000 | 68,465 | 4,220.9 | 3 | 4,207.9 |
| 3 | After | 16 | 6,462 | 1,458.9 | 1 | 1,447.2 |

| Sample | Version | Frames sampled | Frames >32 ms | Max frame ms | Scroll long tasks | Scroll long-task ms |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| 1 | Before | 120 | 1 | 33.5 | 0 | 0 |
| 1 | After | 120 | 13 | 50.7 | 0 | 0 |
| 2 | Before | 120 | 0 | 30.0 | 0 | 0 |
| 2 | After | 120 | 15 | 43.9 | 0 | 0 |
| 3 | Before | 120 | 0 | 30.1 | 0 | 0 |
| 3 | After | 120 | 10 | 55.5 | 1 | 56 |

Median mount elapsed time fell from **4,220.9 to 1,438.3 ms**. Mounted message
rows fell from **3,000 to 16**; total document elements fell from **68,465 to
6,462**. The synthetic scrolling sweep has **more slow frames after** (10–15 of
120, versus 0–1 before), and one after sample contains a scroll long task.
The baseline can scroll its already-mounted DOM without mounting new rows;
virtual scrolling does Vue/Element Plus row work during the sweep. These results
establish bounded row mounting and reduced initial render cost, not universally
better scrolling throughput. Earlier samples varied with concurrent validation
and host load; the recorded final run had no concurrent npm test/build job.
The runner prints machine-precision JSON for each reproduction.

## Limits

Virtualization bounds mounted message rows, not the loaded data arrays, filtering,
sorting, payload codec work, or topic-option list. This deliberately unique-topic
dataset still mounts thousands of Element Plus topic options; total DOM count
therefore exceeds the message-row DOM alone. Very large individual expanded
payloads can still cost time and memory. This benchmark tests 3,000 messages,
not 10,000; baseline full-DOM mount cost and host timing variation limit claims.
No native Windows performance result or real SQLite/MQTT integration benchmark
is asserted. Chromium geometry assertions complement jsdom's synthetic-layout
component tests; jsdom alone cannot prove anchoring correctness. Dependency
upgrades should rerun Chromium checks because `_willUpdate` is a library lifecycle
method rather than a consumer-facing scrolling API.
