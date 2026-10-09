import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const baselinePath = "src/stores/.issue32-baseline.ts";
const temporary = mkdtempSync(join(tmpdir(), "issue32-receive-"));
const fixture = join(temporary, "fixture.json");
const result = join(temporary, "result.json");
const base = "28fb7fa6b9afba84a0f7ae205fe8969511488e4b";
// Only observe the original store. Pending entries remain charged until both
// display and history complete; use the same conservative byte charge as after.
let baseline = execFileSync("git", ["show", `${base}:src/stores/mqtt.ts`], { encoding: "utf8" });
const probe = `
export const baselineReceiveStats = { pendingCount: 0, pendingBytes: 0, peakCount: 0, peakBytes: 0 };
const pending = new Map<number, { bytes: number; display: boolean; history: boolean }>();
function admitted(seq: number, bytes: number) {
  pending.set(seq, { bytes, display: false, history: false });
  baselineReceiveStats.pendingCount++; baselineReceiveStats.pendingBytes += bytes;
  baselineReceiveStats.peakCount = Math.max(baselineReceiveStats.peakCount, baselineReceiveStats.pendingCount);
  baselineReceiveStats.peakBytes = Math.max(baselineReceiveStats.peakBytes, baselineReceiveStats.pendingBytes);
}
function done(seq: number, stage: 'display' | 'history') {
  const entry = pending.get(seq); if (!entry) return; entry[stage] = true;
  if (entry.display && entry.history) {
    pending.delete(seq); baselineReceiveStats.pendingCount--; baselineReceiveStats.pendingBytes -= entry.bytes;
  }
}
`;
baseline = probe + baseline;
baseline = baseline.replace("const seq = nextSeq++; //", "const seq = nextSeq++; admitted(seq, msg.payload.length * 8 + msg.topic.length * 2 + 512); //");
baseline = baseline.replace("messageQueue.length = 0;", 'for (const message of messageQueue) if (message.direction === "receive") done(message.seq!, "display");\n    messageQueue.length = 0;');
baseline = baseline.replace('console.warn("Failed to persist received message:", error);\n      }', 'console.warn("Failed to persist received message:", error);\n      }\n      done(seq, "history");');
let baselineCreated = false;
try {
  writeFileSync(baselinePath, baseline, { flag: "wx" });
  baselineCreated = true;
  const env = { ...process.env, ISSUE32_BENCH_FIXTURE: fixture, ISSUE32_BENCH_RESULT: result };
  execFileSync("cargo", ["test", "--manifest-path", "src-tauri/Cargo.toml", "--locked", "receive_benchmark_fixture", "--", "--ignored"], { env, stdio: "inherit" });
  execFileSync("npx", ["vitest", "run", "src/stores/receiveBenchmark.test.ts"], { env, stdio: "inherit" });
  const { readFileSync } = await import("node:fs");
  console.log(readFileSync(result, "utf8"));
} finally {
  if (baselineCreated) rmSync(baselinePath, { force: true });
  rmSync(temporary, { recursive: true, force: true });
}
