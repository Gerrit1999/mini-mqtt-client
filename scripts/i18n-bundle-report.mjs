import { build } from "vite";
import { gzipSync } from "node:zlib";

// Use the actual production config, without rewriting dist or application sources.
const result = await build({
  build: { write: false },
  logLevel: "warn",
});
const outputs = Array.isArray(result) ? result : [result];
const chunks = outputs.flatMap(output => output.output).filter(chunk => chunk.type === "chunk");
const modules = chunks.flatMap(chunk => Object.entries(chunk.modules));
const compiler = modules.filter(([id]) => id.includes("/@intlify/message-compiler/"))
  .map(([id, info]) => ({ id, renderedLength: info.renderedLength, renderedExports: info.renderedExports, removedExports: info.removedExports }));
const yaml = modules.filter(([id, info]) => /\/node_modules\/(?:js-yaml|yaml|yaml-eslint-parser)\//.test(id) && info.renderedLength > 0);
const runtime = modules.filter(([id]) => /vue-i18n\.runtime\.(?:mjs|esm-bundler\.js)$/.test(id));
if (yaml.length) throw new Error(`Unexpected runtime YAML parser: ${yaml.map(([id]) => id).join(", ")}`);
if (!runtime.length) throw new Error("Vue I18n runtime-only module missing");
const compilationExports = ["baseCompile", "createParser", "createTokenizer"];
for (const module of compiler) {
  if (module.renderedExports.some(name => compilationExports.includes(name))) {
    throw new Error(`Runtime message compiler retained: ${module.id}`);
  }
  if (!["baseCompile", "createParser"].every(name => module.removedExports.includes(name))) {
    throw new Error(`Cannot verify compiler/parser removal: ${module.id}`);
  }
}
const sizes = chunks.map(chunk => ({
  file: chunk.fileName,
  main: chunk.isEntry,
  raw: Buffer.byteLength(chunk.code),
  gzip: gzipSync(chunk.code).length,
}));
console.log(JSON.stringify({
  chunks: sizes,
  total: sizes.reduce((total, chunk) => ({ raw: total.raw + chunk.raw, gzip: total.gzip + chunk.gzip }), { raw: 0, gzip: 0 }),
  runtimeOnly: runtime.map(([id]) => id),
  yamlParserModules: yaml.length,
  compiler,
}, null, 2));
