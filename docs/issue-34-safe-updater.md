# Issue #34: safe application updater

Implemented against baseline `71a94df39883030e030cf354125e1a232fb065a9` on `feat/issue-34-safe-updater`.
Specification: [Issue #34](https://github.com/Gerrit1999/mini-mqtt-client/issues/34), read with
`gh issue view 34 --repo Gerrit1999/mini-mqtt-client --json title,body`.

## Policies and integration

- `src/stores/updater.ts` owns native `Update` resources. Its public operations are
  `initialize`, `check`, `download`, `install`, `defer`, `skipVersion` and `dispose`.
  `setPreferences` saves the two settings staged by SettingsDialog.
- App initializes the updater after theme, locale, application settings and MQTT
  listeners finish setting up. Startup checks wait eight seconds. Automatic checks
  are throttled for 24 hours, including across restarts. Manual checks bypass that
  throttle and share any in-flight check, receiving success or explicit failure feedback.
  Failed automatic checks log without displaying an error notification.
- Automatic checking and downloading default to enabled. Following the existing
  local UI settings convention, localStorage keys are `mqtt-client-update-auto-check`,
  `mqtt-client-update-auto-download`, `mqtt-client-update-skipped-version` and
  `mqtt-client-update-last-checked-at`. Invalid boolean values use the defaults;
  invalid, negative, nonfinite and future timestamps do not suppress startup checking.
  Last-check time records attempts, including failed attempts, to avoid retrying
  automatically on every restart during a network failure.
- Check and download use the installed plugin API's millisecond timeouts:
  `check({ timeout: 30000 })` and `Update.download(callback, { timeout: 300000 })`.
  Downloading and installation are separate. Download completion never installs
  or relaunches. Repeated downloads and installations share their active operation.
- UpdateStatus is always mounted in App and also appears within settings. It shows
  version, release date, text-only release notes, progress, ready state and interactive
  errors. Later collapses the global card into a persistent reminder; the sidebar
  badge or reminder expands it. Skip persists the version and discards its resources.
  Opening and closing settings preserve the update and any ongoing download.
- Only a user invocation of `install()` can reach native installation. The public
  store method always asks for consent, listing current impacts in the selected
  language, with restart/update, Cancel and Later controls. This covers every UI entry.
  All servers' connected, connecting and reconnecting states are included. App
  registers running scheduled publishing and timed messages independently of
  whether their dialogs are visible.
- Draft getters cover publish data and format (including a collapsed/hidden panel),
  server fields and group, subscription fields, template fields and scope, script
  fields/imported code, environment variable fields, and staged settings/data path.
  Merely opening an unchanged form does not add an impact. Form reset/save updates
  the baseline; closed dialogs are inactive; component scope disposal removes entries.
  Save baselines record submitted values, so further edits during an asynchronous
  save remain unsaved while the form remains active. Sending a publish message does
  not persist its draft.
- Consent and activity/draft snapshots are revalidated after confirmation and log
  flushing, immediately before invoking native installation and again before relaunch.
  A changed snapshot requires new consent. `errorLogBuffer.flush()` completes before
  both native steps; failure aborts that step. Cancelling retains the ready update.
- Failed rechecks retain consistent prior metadata/resource state. Failed downloads
  can retry the retained update. Failed installation retains downloaded bytes. A
  successful installation is remembered, so a subsequent flush/relaunch retry does
  not call install again. Rechecking the same version preserves downloaded bytes.
- Replacement, skip and disposal explicitly close resources. Generation checks
  reject stale progress/completions. Closing waits for active operations; failed
  cleanup remains owned for disposal retry. Native window close extends the existing
  handler: log flush, updater disposal, then destroy. There is no second close handler.
  Pending consent is explicitly settled on Later or disposal because Element Plus
  `MessageBox.close()` alone does not settle its promise.

Exit-time automatic installation is omitted. Signing configuration, public key,
stable endpoint, release versions, dependencies and lockfiles are unchanged.

## Test evidence

Work proceeded in vertical slices. Representative observed red results and their
green follow-ups used the same focused commands:

| Command | Observed red | Result after implementation |
| --- | --- | --- |
| `npm test -- src/stores/updater.test.ts` | Missing updater module; concurrent check invoked native check twice; no background progress; missing skip/install operations | Startup delay/throttle, shared check, progress, deferred resource close and public protection pass |
| `npm test -- src/stores/updater.test.ts` | New replacement resource leaked when old close failed; failed skip close was not retried; activity in the final microtask reached install | Cleanup ownership/retry and final native-boundary revalidation pass |
| `npm test -- src/stores/updater.test.ts` | Manual caller joining an automatic download received no visible failure | Joined manual failure feedback passes |
| `npm test -- src/components/settings/UpdateStatus.test.ts` | Automatic failure displayed a global card; real Later control left phase at installing | Quiet automatic errors and settled real UI cancellation pass |
| `npm test -- src/composables/useUpdateProtection.test.ts` | Changed hidden publish/environment/server/script fields absent from confirmation; edits during save incorrectly cleared | Draft impacts and asynchronous save retention pass |
| `npm test -- src/components/settings/SettingsDialog.test.ts` | Old clearUpdateInfo call failed after migration; missing switches; close control retained staged switch changes | Metadata retention, Save/Cancel and close reset pass |
| `npm test -- src/components/layout/Sidebar.test.ts` | Old startup updater call failed; badge did not reopen feedback | Badge feedback and subscription dirty protection pass |
| `npm test -- src/utils/errorLogLifecycle.test.ts` | Native destroy happened without updater disposal | Flush → dispose → destroy passes |

The template test initially exposed an incomplete Element form stub; the fixture
was corrected to use the real form before interpreting its behavior. Build checks
also caught test-only TypeScript errors (unused import, DOMWrapper.get/exists and
MessageBox message overload typing), which were corrected. No claim is made that
all tests were written before implementation.

The agreed seams are the updater public API and user-visible settings, status and
consent interactions. Native updater/process APIs, time, native invoke/event APIs
and existing log-flush boundary tests use mocks. Protection tests exercise real
stores/registry and mounted forms. The Later/disposal interaction uses real Element
Plus confirmation UI. Existing app-store flush-order checks were migrated, preserving
both pre-install and pre-relaunch failure checks.

Reproduce focused validation:

```sh
npm test -- src/stores/updater.test.ts src/stores/app.test.ts src/composables/useUpdateProtection.test.ts src/components/settings/UpdateStatus.test.ts src/components/settings/SettingsDialog.test.ts src/components/layout/Sidebar.test.ts src/utils/errorLogLifecycle.test.ts src/i18n/locales.test.ts src/stores/app.locale.test.ts
npm run build
git diff --check
```

Focused result: 9 files, 66 passing tests. Full frontend validation with `npm test`:
33 files passed, one existing benchmark file skipped; 296 tests passed, one skipped.
Locale key parity and existing locale/date synchronization checks pass.
`npm run build` passes (`vue-tsc --noEmit` and Vite); Vite reports its bundle-size
warning. `git diff --check` passes. A protected-file diff check confirms no changes
to package/dependency lockfiles, `skills-lock.json` or `src-tauri`. HEAD remains at
the baseline; this session created no commit or external write.

## Changed files

| Area | Files |
| --- | --- |
| Updater and migrated app seam | `src/stores/updater.ts`, `src/stores/updater.test.ts`, `src/stores/app.ts`, `src/stores/app.test.ts` |
| Global status and settings | `src/components/settings/UpdateStatus.vue`, `UpdateStatus.test.ts`, `SettingsDialog.vue`, `SettingsDialog.test.ts` |
| Startup and native close | `src/App.vue`, `src/main.ts`, `src/utils/errorLogLifecycle.ts`, `src/utils/errorLogLifecycle.test.ts` |
| Shared protection | `src/composables/useUpdateProtection.ts`, `src/composables/useUpdateProtection.test.ts` |
| Draft registration and sidebar | `src/components/mqtt/PublishPanel.vue`, `ServerFormDialog.vue`, `src/components/layout/Sidebar.vue`, `Sidebar.test.ts`, `src/components/template/TemplateDialog.vue`, `src/components/script/ScriptDialog.vue`, `src/components/env/EnvDialog.vue` |
| Locale and evidence | `src/i18n/locales/en-US.yaml`, `src/i18n/locales/zh-CN.yaml`, `docs/issue-34-safe-updater.md` |

## Platform limits and remaining native smoke checks

These tests do not verify a Windows installer, signed release download, actual process
termination/restart or native MQTT traffic. The installed updater JS and Rust code
were inspected: installation failure retains the bytes resource, successful installation
consumes it, and `Update.close()` releases update/download resources. Windows may
exit during `install()`, so the pre-install flush and consent are essential even when
the explicit relaunch path never runs.

Downloaded bytes are retained within the process by the plugin; they are not promised
to survive application restarts. Disposal waits for an active plugin request to settle
(bounded check/download timeouts); the plugin exposes no install timeout or cancellation.
Activity protection uses current frontend MQTT/task/draft state and cannot atomically
lock independent native activity while the OS installer runs.

Parent native smoke checks: startup delay and persisted daily throttle, manual network
failure, close/reopen settings during a signed background download, progress outside
settings, Later/Skip, multiple connected/reconnecting servers, hidden scheduled/timed
tasks, changed versus unchanged drafts, cancellation/retry, and explicit Windows
installation/relaunch with log flushing. No native processes or user data were changed
by this implementation session.

## Script creation regression follow-up

The mounted ScriptDialog/public `updater.install()` seam now covers successful
creation with and without edits made while creation is pending, a subsequent save
of those edits, and selection of another script before creation completes.
Tests were added before the fix. `npm test -- src/composables/useUpdateProtection.test.ts`
first returned **RED: 3 failed, 7 passed**: the unchanged create removed its editor,
the changed create lost its unsaved warning, and switching scripts received the
submitted draft's baseline. The same command after the fix returned **GREEN:
10 passed**.

ScriptStore's actual `createScript` contract returns an ID after reloading scripts.
ScriptDialog selects the matching reloaded Script, falling back to the submitted
fields plus that returned ID if the reload has no matching entry. It preserves the
current form fields and records only the submitted snapshot as saved. Selection
and baseline changes are guarded by the submitted form's identity, server ID and
dialog visibility, so a newer editing context is retained.

Preliminary worker checks (complete final validation remains with the parent):

```sh
npm test -- src/composables/useUpdateProtection.test.ts src/stores/script.test.ts src/utils/scriptCache.test.ts src/utils/scriptCompiler.test.ts src/utils/scriptEngine.test.ts src/utils/scriptErrorRouting.test.ts
npm run build
git diff --check
```

Results: **6 files / 32 tests passed**; `vue-tsc --noEmit` and Vite build passed
with the bundle-size warning; `git diff --check` passed. This follow-up changed
only ScriptDialog, its existing protection test file and this evidence document.
Existing Issue #34 edits were retained. No commit, push, PR, external write,
dependency change or native process/data change was performed.

## Persisted skipped-release accuracy follow-up

A check that discovers the persisted skipped version now enters `skipped`, with
`hasUpdate: false` and the discovered version, date and release notes retained in
public metadata. The candidate resource is explicitly closed and is not retained
for download or installation. Checking manually preserves the skip preference and
reports the actual skipped version in the selected language; Settings shows the
same message and only labels an explicit `up_to_date` result as current. Automatic
skipped results produce no notification or global update card. A different newer
version is still offered normally. Existing replacement behavior clears prior
downloaded state when replacing it with a skipped result, so no stale restart
action remains.

Regressions were added before the fix at the public `check()` and mounted Settings
seams. `npm test -- src/stores/updater.test.ts src/components/settings/SettingsDialog.test.ts`
returned **RED: 5 failed, 25 passed**. The persisted 1.9.0 result on current 1.8.1
incorrectly reported `v1.8.1`, lost the release date/notes and displayed up-to-date
feedback. The Chinese Settings fixture was then corrected to load its lazy locale
messages before selecting Chinese.

Preliminary worker checks (final review/validation remains with the parent):

```sh
npm test -- src/stores/updater.test.ts src/components/settings/SettingsDialog.test.ts src/components/settings/UpdateStatus.test.ts src/i18n/locales.test.ts
npm run build
git diff --check
```

Results: **GREEN: 4 files / 46 tests passed**; `vue-tsc --noEmit` and Vite build
passed with the bundle-size warning; `git diff --check` passed. Regressions cover manual and automatic skip
policy, localized Settings status and manual feedback, preserved skip preference,
accurate metadata, no download/install/relaunch, one resource close including
disposal, a newer 2.0.0 offer, and consistent replacement of a ready update.
UpdateStatus already hides resource-free results, so its rendering required no
change. This follow-up changes only the updater store/tests, Settings status/tests,
the two locale files and this document. All other Issue #34 edits are preserved;
no commit, push, external write or dependency change was performed.

## Parent final validation (2026-10-10)

After independent review and both follow-up fixes, the parent ran `npm test`:
**305 tests passed across 33 files; one existing opt-in benchmark was skipped**.
`npm run tauri -- build --debug --no-bundle -- --locked` passed, including the
frontend type check, production Vite build and native Linux application build.
The existing Vite chunk-size warning remains. Application versions, dependency
manifests/locks, Rust source, signing configuration and stable endpoint are unchanged.

The parent executed the real native harness against this branch's embedded
production frontend:

```sh
NATIVE_APP=/home/gerrit/.paseo/worktrees/1uom67lp/issue-34-safe-updater/src-tauri/target/debug/mini-mqtt-client \
  python3 /tmp/mini-mqtt-issue34-native-validation/run.py
```

**All 20 native checks passed**: six updater checks and the 14 existing desktop/MQTT
checks. The updater checks observed the eight-second startup delay, persisted
24-hour restart throttle, disabled auto-check on restart, preference Save/Cancel,
manual checking despite disabled automatic checking and the throttle, and update
result retention across settings interactions. Manual checking contacted the real
native updater endpoint and displayed “You are up to date” in 2.40 seconds for
the current release. No native updater or IPC was mocked.

The existing checks retained real MQTT 3.1.1/5.0, text/binary QoS 0/1/2, receive
history, CRUD, script/environment changes, scheduled stop, filtering/details,
locale/theme restart and native-close log flushing. Read-only SQLite evidence
contained 38 messages; native close persisted its error batch in 0.174 seconds.
The harness uses isolated XDG directories and only cleans up its own processes.

Evidence: `/tmp/mini-mqtt-issue34-native-validation/run-jfz1eg8i/run-20261010-111048/results.json`
and screenshots in that directory. Reproduction wrapper and notes are under
`/tmp/mini-mqtt-issue34-native-validation`; the shared original harness is unchanged.

Native availability/background-download/skip/install protection were not exercised
against a newer signed release. Their behavior is covered by the public updater
and mounted component tests. Windows/macOS installer execution and actual updater
relaunch remain unverified. The embedded settings view intentionally keeps the
update details visible after Later; Later collapses the global reminder and
preserves the ready update.
