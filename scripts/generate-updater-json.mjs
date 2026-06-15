import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const repo = process.env.GITHUB_REPOSITORY || "Gerrit1999/mini-mqtt-client";
const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
const version = packageJson.version;
const bundleDir = "src-tauri/target/release/bundle";
const output = join(bundleDir, "latest.json");

const platformCandidates = [
  {
    platform: "linux-x86_64",
    dir: "appimage",
    matcher: (file) => file.endsWith(".AppImage"),
  },
  {
    platform: "windows-x86_64",
    dir: "nsis",
    matcher: (file) => file.endsWith(".exe"),
  },
  {
    platform: "darwin-x86_64",
    dir: "dmg",
    matcher: (file) => file.endsWith(".dmg") && file.includes("x64"),
  },
  {
    platform: "darwin-aarch64",
    dir: "dmg",
    matcher: (file) => file.endsWith(".dmg") && file.includes("aarch64"),
  },
];

const platforms = {};

for (const candidate of platformCandidates) {
  const dir = join(bundleDir, candidate.dir);
  if (!existsSync(dir)) continue;

  const file = readdirSync(dir).find((name) => candidate.matcher(name));
  if (!file) continue;

  const signaturePath = join(dir, `${file}.sig`);
  if (!existsSync(signaturePath)) {
    throw new Error(`Missing updater signature for ${file}`);
  }

  platforms[candidate.platform] = {
    signature: readFileSync(signaturePath, "utf8").trim(),
    url: `https://github.com/${repo}/releases/download/v${version}/${encodeURIComponent(file)}`,
  };
}

if (Object.keys(platforms).length === 0) {
  throw new Error(`No signed updater artifacts found under ${bundleDir}`);
}

const metadata = {
  version,
  notes: "",
  pub_date: new Date().toISOString(),
  platforms,
};

writeFileSync(output, `${JSON.stringify(metadata, null, 2)}\n`);
console.log(`Generated ${output}`);
