# Live follow during continuous receives

Baseline: `e1397c7090b9584f73cefc3bd7a51e658ccc5d89` (merged PR42).
Worker diagnosis and parent final verification collected on 2026-10-10.

## Reproduced failures and cause

Two independent no-input failures reproduce with the actual component in Chromium
146.0.7680.177 and the pinned Vue Virtual 3.13.39 / virtual-core 3.17.11:

1. **Empty → first live batch.** The Vue adapter calls `_willUpdate()` before
   rendering. Core consumes its pending append follow and calls `scrollToEnd()`.
   `getOffsetForIndex()` reads `measurementsCache[index]` directly and returns if
   absent. On the empty transition the old cache has zero entries; no reading
   anchor caused `setOptions()` to rebuild it before the call. Tagged temporary
   command tracing observed count **128**, cache length **0**, offset **0** at
   `scrollToEnd`/`scrollToIndex(127)`. The post-render hook cannot replay the
   already-consumed pending follow. A fixed header removes height changes and
   Chromium still fails: **9,437 px** gap after the first 128 receives, with
   unchanged **526×618** viewport. This is not solely a resize failure.
2. **Retained history + capped live queue.** Core's `isAppendWithTrim()` accepts
   a contiguous retained suffix beginning at the next first key. A retained
   historical prefix pins the first key while live rows disappear from the
   middle. At unchanged merged count, this is rejected as an append; the reading
   anchor wins. Minimal Chromium case: 12 live rows, overlapping 12-row history
   snapshot, collapsed preview, 13 sparse single arrivals. The first 12 follow;
   the 13th has an **88 px** gap, unchanged **1198×745** viewport and 24 merged
   rows. Expanded 80-row/10-arrival batches first failed with **1,339 px** gap.

Production `mqtt.ts` assigns persisted receive IDs after
`save_received_messages`, then flushes the displayed rows (lines 168–172).
`flushMessageQueue` concatenates, sorts by session seq and retains
`slice(-messageLimit)` (lines 235–248). Receive count is cumulative (204–208),
independent of retained length. `message.ts` initial history fetch retains a
snapshot of the newest `min(200, messageLimit)` records; receives do not slide
that snapshot. MessageList deduplicates shared persistence IDs and retains the
historical prefix after its live counterpart leaves the queue. These actual
transitions drive the fixture, rather than arbitrary whole-list replacement.

Before instrumentation the ranked predictions were: viewport bottom checks
become false after layout changes; cap trimming defeats append detection; row
measurement drift. Uncapped resize failed too, eliminating trimming for that
case. Sparse collapsed retained-history failed at a static size, eliminating
JSON expansion and overlapping observer work as requirements for rollover.
Removing history passed five live-window turnovers plus per-frame arrivals.
The empty-cache trace separately confirmed the empty-transition lifecycle defect.
All temporary `[DEBUG-live-follow]` instrumentation was removed.

## Native baseline corroboration

Parent's actual Linux Tauri/WebKitGTK baseline, real isolated Mosquitto/Paho,
default enabled auto-scroll, no scroll/layout input:

- Empty start, 32×128 arrivals at 0.3 s: first gap **10,689 px**, final
  **87,064 px** at **1000 / 4096**. Height stays 541; first overflow changes
  clientWidth **532 → 526** through a real 6 px scrollbar.
  `/tmp/mini-mqtt-native-validation/run-20261010-115311/live-follow-results.json`.
- Seed 256 persisted receives, reopen session with 200 retained history rows,
  then 16×128 new receives: first eight batches gap **0**, batch nine gap
  **11,264 px**, final gap **78,882 px** at **1200 / 2048**, fixed **526×541**.
  `/tmp/mini-mqtt-native-validation/run-20261010-120216/retained-history-live-follow-results.json`.
- The worker's standalone warm-history script independently reproduced those
  exact rollover gaps and counts:
  `/tmp/mini-mqtt-native-validation/run-20261010-120438/retained-history-live-follow-results.json`.
  Its one-batch empty baseline run observed **10,107 px** gap:
  `/tmp/mini-mqtt-native-validation/run-20261010-115858/live-follow-results.json`.

Native overflow width reflow can add another conflicting operation:
`invalidateMeasurements()` previously checked bottom against the already-grown
DOM and restored an earlier row. Chromium's fixed-height 6 px gutter proxy
observed `atEnd=false` during that invalidation and a **10,053 px** first-batch
gap. This controlled proxy is not a native scrollbar test. Ordinary Chromium
also shows an automatic 2 px header-height change when the first count badge
appears. Counter digit growth can affect the flex header; load-more appearance
and responsive panel/header changes are other actual layout paths. None is
necessary for the static retained-history failure, and no general claim that
all reports originate in resizing is made.

## Correction and policies

Capture bottom eligibility before the adapter updates. Schedule a guarded
post-commit `scrollToEnd()` only for the first live tail or an advancing live seq
whose merged count did not grow. Ordinary count-growing arrivals continue using
the library. A microtask yield lets Vue queue its adapter/render update before
`nextTick()` waits for the commit. There is no flush-event listener, polling,
timer, dependency change, or row scan.

Remember bottom state at committed viewport dimensions, including empty mount.
Width remeasurement uses that pre-resize state; height changes preserve active
follow. A disabled already-bottom view still stays bottom on width/format reflow,
while subsequent disabled arrivals stay put. The second worker reproduced an
exception in the first patch: disabling before empty → 128 receives introduced
the native 6 px scrollbar and forced top **0 → 10247** despite inactive follow
(`/tmp/mini-mqtt-native-validation/run-20261010-120945/disabled-empty-overflow.json`).
A fixed-header Chromium 6 px gutter proxy failed identically, top **0 → 10624**.
The correction records outer width, overflow and the message collection at
committed geometry. First overflow at unchanged outer width with changed messages
preserves the disabled reading anchor; an empty view anchors its first row.
Removing only bottom alignment still selected a newly mounted row at **582 px**,
so explicit first-row anchoring is also required.

An independent short-content test caught format expansion being mistaken for
arrivals: a collapsed row fit a **238 px** viewport, expansion/gutter grew it to
**628 px** and left a **390 px** gap. An unchanged message collection identifies
this deliberate format reflow, preserving the pre-reflow bottom intent. Both
focused gutter regressions now pass: disabled arrivals remain at **top 0**,
disabled explicit expansion finishes at **gap 0**. Existing generations plus scroll
intent guard deferred work against disable, filter/server changes, unmount and
wheel/touch/scrollbar/key input. Reading away from bottom remains anchored;
filter first-result positioning, history prepend, guarded delayed initial
history, bounded mounting and full-history export remain covered.

## Reproduction

Run from the worktree root. No repository dependency/lock changes are needed.

```sh
npm ci --no-audit
export PLAYWRIGHT_MODULE=/tmp/issue31-playwright/node_modules/playwright/index.mjs
export BASELINE_REF=e1397c7090b9584f73cefc3bd7a51e658ccc5d89

# Minimized empty baseline red (exit 1, gap 9437; static viewport).
LIVE_FOLLOW_EMPTY=1 LIVE_FOLLOW_VERSION=before LIVE_FOLLOW_FIXED_HEADER=1 \
  LIVE_FOLLOW_BATCHES=1 node scripts/verify-message-list.mjs

# Minimized retained-history baseline red (exit 1, step 12 gap 88).
LIVE_FOLLOW_STATIC=1 LIVE_FOLLOW_HISTORY=1 LIVE_FOLLOW_VERSION=before \
  LIVE_FOLLOW_COUNT=12 LIVE_FOLLOW_BATCH=1 LIVE_FOLLOW_COLLAPSED=1 \
  node scripts/verify-message-list.mjs

# Same cases against the candidate: omit LIVE_FOLLOW_VERSION=before.
# Focused disabled first-overflow and deliberate format-overflow policies:
LIVE_FOLLOW_DISABLED=1 node scripts/verify-message-list.mjs
LIVE_FOLLOW_FORMAT_OVERFLOW=1 node scripts/verify-message-list.mjs
# Full browser behavior checks plus one paired benchmark sample:
BENCHMARK_SAMPLES=1 node scripts/verify-message-list.mjs
npx vitest run src/components/mqtt/MessageList.test.ts src/components/mqtt/MessagePayload.test.ts
npm run build
```

`LIVE_FOLLOW_ONLY=1` runs the new follow/reflow cases without the older benchmark
and behavior cases. Default coverage includes empty 32×128 receives through a
1000 cap; automatic count-badge layout; fixed-height 6 px overflow gutter proxy;
200 overlapping history rows and a 240 live cap; 128-arrival bursts through five
turnovers; 480 per-frame arrivals with mixed 1/10 batch sizes; 20 sparse arrivals;
expanded JSON; height/width changes; disabled bottom reflow followed by disabled
arrivals; disabled empty first-overflow and short-content format expansion.
The fixture counter is cumulative and receive-only workloads carry
persisted IDs before display. Stores, history and file IPC remain mocked.

Native reruns use the small standalone wrapper, importing the unchanged shared
Harness and selecting a binary explicitly:

```sh
NATIVE_APP=/absolute/path/to/mini-mqtt-client \
  python3 /tmp/mini-mqtt-live-follow-validation/run.py
NATIVE_APP=/absolute/path/to/mini-mqtt-client \
  python3 /tmp/mini-mqtt-live-follow-validation/run.py --warm-history
NATIVE_APP=/absolute/path/to/mini-mqtt-client LIVE_FOLLOW_BATCHES=1 \
  python3 /tmp/mini-mqtt-live-follow-validation/run.py
NATIVE_APP=/absolute/path/to/mini-mqtt-client \
  python3 /tmp/mini-mqtt-live-follow-validation/run.py --disabled
```

It isolates XDG data, broker/driver ports and owned processes; saves all 32/16
batch observations and a screenshot; never reads Vue/private stores. Final
completion requires actual cumulative/retained counts, mounted rows, latest
payload visible and bottom gap ≤3. It waits at most five seconds for final delivery
completion, then settles 0.2 seconds. Every raw 0.3 s sample is retained. An
incomplete delivery/position pauses publishing for at most one additional second,
requiring three consecutive 50 ms completed/bottom observations. A failed batch
stays failed even if subsequent arrivals repair it; completed samples retain the
original cadence. `LIVE_FOLLOW_SETTLE_SECONDS` configures that bound. Disabled
mode defaults to one batch and requires inactive follow, unchanged top, actual
overflow/gutter and completed counts, with a nonzero final gap. Default enabled
final counts are 1000/4096; warm mode 1200/2048.

## First-patch native settling audit

The parent's strict 32-sample run
`/tmp/mini-mqtt-native-validation/run-20261010-120856/live-follow-results.json`
**failed**: first 0.3 s sample gap **1161**, batches 2–32 gap **0**, final
1000/4096 and latest visible. It is not reported as 32 passing samples.

The second worker sent a single 128 batch, with no later messages, to the same
first-patch binary. In
`/tmp/mini-mqtt-native-validation/run-20261010-121359/live-follow-results.json`,
gap **1161** remained at elapsed **0.385/0.441 s**, then became **0** at
**0.496 s**, stayed **0** through **0.608 s**, and finished with latest visible.
This supports asynchronous autonomous settling, not next-batch repair. The old
baseline under the same bounded helper remained **10107 px** behind through
**1.352 s**, latest invisible, exit 1:
`/tmp/mini-mqtt-native-validation/run-20261010-121441/live-follow-results.json`.
The final helper was rerun independently: first-patch single-batch gap **1161**
at **0.305 s**, bottom by **0.363 s**, stable through **0.476 s**, final latest
visible, exit 0 (`run-20261010-121756/live-follow-results.json`). The baseline
still exited 1 with gap **10107** (`run-20261010-121819/live-follow-results.json`).
The disabled control is also red on the first-patch binary, top **0 → 10689**,
inactive follow, exit 1:
`/tmp/mini-mqtt-native-validation/run-20261010-121458/disabled-live-follow-results.json`.

Parent's first-patch warm-history native run passed all 16 raw samples at gap 0,
final **1200/2048**, latest visible:
`/tmp/mini-mqtt-native-validation/run-20261010-121039/retained-history-live-follow-results.json`.
These existing-binary observations precede the second worker's source correction;
the parent must rebuild and rerun final native validation.

## Preliminary validation and limits

- Focused component/payload tests: **58 passed** (54 MessageList, 4 payload).
  New jsdom tests establish cancellation/eligibility, not physical bottom geometry.
- TypeScript + Vite build passed; existing large-chunk warning remains.
- Chromium candidate: minimized empty and retained-history gaps **0 px**;
  empty 4096 stream, retained-history burst/per-frame/sparse workloads and reflow
  checks finish at **0 px**. Browser checks also preserve manual readers, disabled
  width/format bottom position, filters, prepends, delayed history and exports.
- Raw focused logs: `/tmp/mini-mqtt-live-follow-empty-red.log`,
  `/tmp/mini-mqtt-live-follow-history-red.log`,
  `/tmp/mini-mqtt-live-follow-browser-green.log`,
  `/tmp/mini-mqtt-live-follow-tests.log`.
- Additional capped/history actual-wheel reader check passed:
  `/tmp/mini-mqtt-live-follow-static-reader-green.log`.
- Second-worker preliminary component/payload tests: **58 passed**; TypeScript
  and Vite build passed. Full browser checks passed before the short-format
  refinement, including retained-history, disabled deliberate width/format
  reflow, reader anchors, toolbar, filters, prepends, delayed history and export:
  `/tmp/mini-mqtt-second-worker-browser.log`. Both newly minimized browser
  regressions were observed red before their fixes:
  `/tmp/mini-mqtt-disabled-overflow-red.log`,
  `/tmp/mini-mqtt-format-overflow-red.log`; focused greens:
  `/tmp/mini-mqtt-disabled-overflow-green.log`,
  `/tmp/mini-mqtt-format-overflow-green.log`.
  After the short-format refinement, the follow/reflow browser suite passed
  (`/tmp/mini-mqtt-second-worker-follow-green.log`), including disabled deliberate
  width/format policy and retained-history reader anchoring. The 58 focused tests
  and frontend build were rerun successfully on this final source.

Changed repository files: `src/components/mqtt/MessageList.vue`,
`src/components/mqtt/MessageList.test.ts`, `scripts/issue31-fixture.ts`,
`scripts/verify-message-list.mjs`, and this document. Standalone native evidence
files: `/tmp/mini-mqtt-live-follow-validation/run.py` and its `README.md`.

The native baseline is measured with real receive/persistence work; the Chromium
fixture is not native MQTT batching or SQLite validation. The parent's final
verification below covers the rebuilt Linux desktop application. No Windows
claim or performance improvement claim is made. The fixes address reproduced
transitions; they do not prove that every possible follow failure is eliminated.

## Parent final verification

- Full frontend suite: **326 passed**, one existing opt-in benchmark skipped.
  Log: `/tmp/mini-mqtt-live-follow-final-tests.log`.
- `npm run tauri -- build --debug --no-bundle -- --locked` passed frontend type
  checking, production frontend build and Linux debug native build.
  Log: `/tmp/mini-mqtt-live-follow-final-native-build.log`.
- Complete Chromium runner passed all new receive/overflow cases and existing
  reader, filter, prepend, delayed-history, locale, toolbar, export and content-width
  regressions. Log: `/tmp/mini-mqtt-live-follow-final-browser.log`.
  Its one paired 3000-row sample mounted 16 rows for both versions and recorded
  13 frames over 32 ms for both; this run makes no performance improvement claim.
- Parent reviewed the complete production diff and regression additions. An
  independent read-only review of committed geometry, overflow classification
  and cancellation found no confirmed defect within that bounded scope.

All four native reruns use the **final rebuilt binary**, real Mosquitto receives,
real history IPC/persistence and public DOM geometry. Each finished with exit 0.

| Native scenario | Actual delivery / retained rows | Position evidence |
| --- | --- | --- |
| Empty start, 32×128 | 4096 received / 1000 retained | All 32 raw 0.3 s samples gap 0; final gap 0, newest payload visible |
| Persisted 200-row history, 16×128 | 2048 new receives / 1200 retained | All 16 raw samples gap 0 through live-window turnovers; final newest visible |
| Empty start, single 128 then no arrivals | 128 received / 128 retained | Raw sample gap 0 at 0.303 s; final gap 0, newest visible without a later batch |
| Auto-scroll disabled before first 128 | 128 received / 128 retained | Native clientWidth 532→526; top remains 0, inactive follow, final gap 10689 as expected |

Reports, including every raw sample, final counts and screenshot directories:

- `/tmp/mini-mqtt-native-validation/run-20261010-122204/live-follow-results.json`
- `/tmp/mini-mqtt-native-validation/run-20261010-122232/retained-history-live-follow-results.json`
- `/tmp/mini-mqtt-native-validation/run-20261010-122327/live-follow-results.json`
- `/tmp/mini-mqtt-native-validation/run-20261010-122257/disabled-live-follow-results.json`

These final enabled runs passed at the original 0.3 s cadence without needing
the helper's additional settling allowance. The first-patch transient and its
failed strict run remain recorded above. Repository versions, dependencies,
lockfiles and Rust source are unchanged; validation harnesses stay under `/tmp`.
