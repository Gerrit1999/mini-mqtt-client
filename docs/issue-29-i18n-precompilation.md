# Issue #29: i18n precompilation evidence

## Implementation

- Vite uses the already installed `@intlify/unplugin-vue-i18n` 11.0.3 to compile YAML messages into AST resources, with `runtimeOnly: true` and `dropMessageCompiler: true`. Its installed types/source support these options and always use AST generation (`jit: true` internally); no obsolete `jitCompilation` option is used. See the [official optimization guide](https://vue-i18n.intlify.dev/guide/advanced/optimization) and [plugin source/options](https://github.com/intlify/bundle-tools/tree/main/packages/unplugin-vue-i18n).
- English is bundled with the application and remains the default/fallback. Chinese is a separate dynamic import. Import rejection is caught, returns English, and logs the requested locale, fallback, recovery steps and original error. Loading does not mutate the active locale. Concurrent loads share a promise; failures clear that promise so later selections can try again (browser-cached import failures may still require a restart).
- The app store persists the requested preference before loading. Only the latest request can change the displayed locale. `actualLocale`, date formatting and reactive Element Plus options follow the displayed locale, including English after failure. Startup mounts a usable English UI immediately; the existing App initialization applies the saved preference asynchronously. Invalid saved preferences still select `auto`, Chinese system languages select Chinese, and other system languages select English.
- A build-start validator rejects invalid YAML, non-string leaves, empty objects, cyclic aliases, mismatched keys and invalid message syntax, with locale/key diagnostics. Both locales are validated even when Chinese is never requested. The two double-brace help messages use literal interpolation to preserve the displayed `{{var}}` / `{{变量名}}` text.
- A source search confirmed the original `js-yaml` consumers were only `src/i18n/index.ts` and `src/i18n/locales.test.ts`. Parsing now exists only in the build/test validator. `js-yaml` stays a dev dependency. `@intlify/message-compiler` 11.2.8 is now a direct dev dependency for validation (the same version was already installed transitively); Node 22 types support the validator/tests. No existing dependency version was upgraded and no runtime dependency was added.

## Verification

Commands run from the worktree root:

```bash
npm ci
npm test
I18N_RUNTIME_ONLY_TEST=1 npx vitest run src/i18n src/stores/app.locale.test.ts src/stores/app.test.ts
npx vitest run src/components/template/TemplateDialog.test.ts src/components/mqtt/SubscriptionTopicTree.test.ts src/components/mqtt/ScheduledPublishDialog.test.ts src/components/mqtt/PublishPanel.test.ts src/components/mqtt/MessageList.test.ts
npm run build
node scripts/i18n-bundle-report.mjs
```

- Parent final validation: **27 files, 231 tests passed** in the complete frontend suite; production build and type checking passed. Two independent source reviews found no blocking locale-flow or build-pipeline defects.
- Focused runtime-only suite: **4 files, 26 tests passed**, repeated by the parent. Covers real AST messages in both languages, named interpolation, literal braces, missing-key English fallback, a rendered usable UI after rejected Chinese import, diagnostics, shared in-flight loading, switching, restored settings, auto/invalid preferences, date locale and stale success/failure results. A real Element Plus pagination control verifies its translated text follows language changes.
- Existing component suites: **5 files, 106 tests passed**. Default Vitest compilation stays available for their synthetic string-message fixtures; the environment flag above enables runtime-only/compiler-drop testing of the real i18n resources. Both modes precompile imported YAML.
- Regression demonstrated before translation fixes: the new real-resource validation test rejected the original `script.envFunctions.replace` message with `[i18n] en-US:script.envFunctions.replace: invalid message: Not allowed nest placeholder`. Malformed YAML, numeric/boolean/null/array values, missing/extra keys, malformed interpolation/linked syntax and cyclic aliases have rejection tests.
- `npm run build` passed, including TypeScript and both-locale validation. The existing main chunk >500 kB warning remains. CSS remained 259.23 kB.
- `scripts/i18n-bundle-report.mjs` uses Vite's actual production config with `write: false`, inspects Rollup output module metadata and fails if a runtime YAML parser or compiler/parser exports remain. It also computes raw and gzip sizes from the emitted JS chunk code.
- Production includes `vue-i18n/dist/vue-i18n.runtime.mjs`; **zero rendered YAML parser modules**. The message-compiler module has just **379 rendered bytes before minification**, exporting `COMPILE_ERROR_CODES_EXTEND_POINT` and `createCompileError` for shared errors. `baseCompile`, `createParser`, `detectHtmlTag`, source-location helpers and compiler error messages are in `removedExports`. The package's small shared error helpers remain; the runtime message compiler/parser is removed.
- Whitespace checking covers tracked diffs and every new file with `git diff --no-index --check /dev/null <new-file>`; no staging is required.

## Comparable bundle sizes

Local baseline: commit `d26d0a349f57e76a100e2e835d96aa19e832e1ca`, built before source edits after `npm ci` in this same worktree. Environment: Node **22.22.2**, npm **10.9.7**, Vite **6.4.1**, Vue I18n **11.2.8**, plugin **11.0.3**. Baseline was measured from `dist/assets/*.js` using Node `Buffer.length` and `node:zlib.gzipSync` with default settings. After measurements use identical gzip settings on emitted chunk code; totals sum every JS chunk's individual raw/gzip size.

| Asset / metric | Baseline raw bytes | After raw bytes | Baseline gzip bytes | After gzip bytes |
| --- | ---: | ---: | ---: | ---: |
| Main | 1,395,784 | 1,328,100 | 445,118 | 421,204 |
| Chinese locale chunk | 0 | 23,605 | 0 | 5,742 |
| **All JS** | **1,395,784** | **1,351,705** | **445,118** | **426,946** |

Baseline: `index-DPQVnh4R.js` (one JS asset). After: `index-vi7HRX1T.js` and `zh-CN-C1B85fFb.js`.

Main saves **67,684 raw bytes (4.85%) / 23,914 gzip bytes (5.37%)**. Total JS saves **44,079 raw bytes (3.16%) / 18,172 gzip bytes (4.08%)**. The total establishes real savings beyond moving Chinese out of main.

The parent reported a baseline of 1,393,964 / 444,833 bytes at the same base commit/tool versions. The locally reproduced baseline differs by 1,820 raw / 285 gzip bytes; the cause was not isolated. Comparisons above consistently use the local before/after builds, not the parent's smaller baseline. Chunk names and compression are sensitive to emitted code ordering; reproduce with the locked dependencies and the commands above.

## Limits

The scope protects optional Chinese resource loading; failure to deliver the application/main asset itself cannot be recovered by locale fallback. Diagnostics use `console.error`, so no new dependency on the error handler or app store is introduced into i18n. Native Windows/Tauri/WebView end-to-end startup and a real blocked asset request have not been tested; rejection is exercised through an asynchronous import mock and rendering tests.
