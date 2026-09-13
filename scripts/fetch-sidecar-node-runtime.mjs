// Downloads the Node.js binary that Tauri's `externalBin: ["bin/node"]`
// (src-tauri/tauri.conf.json) expects at build time, named for the host's
// Rust target triple: src-tauri/bin/node-<target-triple>[.exe].
//
// tauri-build's build script checks for this file's existence unconditionally
// -- for `cargo build`, `cargo check`, AND `cargo test` alike -- even though
// unit tests never invoke it at runtime. `src-tauri/bin/` is gitignored (it
// is a downloaded/built artifact, matching the comment in .gitignore), so a
// fresh clone has no `cargo` command that succeeds at all until this exists.
// .github/workflows/release.yml already performs the equivalent download for
// its one supported platform/version; this script generalizes that step so
// `cargo test`/`npm run test:rust` also work locally on a fresh checkout,
// without requiring a network fetch on every `npm run verify`.
//
// Idempotent: does nothing if the target binary already exists.

import { existsSync, mkdirSync, chmodSync, rmSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const binDir = path.join(rootDir, "src-tauri", "bin");

// Keep this in lockstep with .github/workflows/release.yml's pinned version.
const NODE_VERSION = readFileSync(path.join(rootDir, ".nvmrc"), "utf8").trim();

const TARGET_TRIPLES = {
  "darwin-arm64": "aarch64-apple-darwin",
  "darwin-x64": "x86_64-apple-darwin",
  "linux-x64": "x86_64-unknown-linux-gnu",
  "win32-x64": "x86_64-pc-windows-msvc",
};

const NODE_DIST_NAMES = {
  "darwin-arm64": { os: "darwin", arch: "arm64", ext: "tar.gz" },
  "darwin-x64": { os: "darwin", arch: "x64", ext: "tar.gz" },
  "linux-x64": { os: "linux", arch: "x64", ext: "tar.xz" },
  "win32-x64": { os: "win", arch: "x64", ext: "zip" },
};

const hostKey = `${process.platform}-${process.arch}`;
const targetTriple = TARGET_TRIPLES[hostKey];
const distInfo = NODE_DIST_NAMES[hostKey];

if (!targetTriple || !distInfo) {
  console.error(
    `[fetch-sidecar-node-runtime] Unsupported host platform/arch: ${hostKey}. ` +
      `Supported: ${Object.keys(TARGET_TRIPLES).join(", ")}. ` +
      `Place src-tauri/bin/node-<your-target-triple> by hand (see .github/workflows/release.yml).`,
  );
  process.exit(1);
}

const isWindows = process.platform === "win32";
const binName = isWindows ? `node-${targetTriple}.exe` : `node-${targetTriple}`;
const binPath = path.join(binDir, binName);

if (existsSync(binPath)) {
  console.log(`[fetch-sidecar-node-runtime] ${binName} already present, skipping download.`);
  process.exit(0);
}

mkdirSync(binDir, { recursive: true });

const distDirName = `node-v${NODE_VERSION}-${distInfo.os}-${distInfo.arch}`;
const archiveName = `${distDirName}.${distInfo.ext}`;
const url = `https://nodejs.org/dist/v${NODE_VERSION}/${archiveName}`;
const archivePath = path.join(binDir, archiveName);

console.log(`[fetch-sidecar-node-runtime] Downloading ${url} ...`);
const response = await fetch(url);
if (!response.ok) {
  console.error(`[fetch-sidecar-node-runtime] Download failed: ${response.status} ${response.statusText}`);
  process.exit(1);
}
const buffer = Buffer.from(await response.arrayBuffer());
const { writeFileSync } = await import("node:fs");
writeFileSync(archivePath, buffer);

console.log(`[fetch-sidecar-node-runtime] Extracting ${archiveName} ...`);
if (distInfo.ext === "zip") {
  // Windows: rely on PowerShell's built-in Expand-Archive (no extra tooling).
  execFileSync("powershell", [
    "-NoProfile",
    "-Command",
    `Expand-Archive -Path '${archivePath}' -DestinationPath '${binDir}' -Force`,
  ]);
} else {
  execFileSync("tar", ["xf", archivePath], { cwd: binDir });
}

const extractedNodePath = path.join(
  binDir,
  distDirName,
  isWindows ? "node.exe" : path.join("bin", "node"),
);

const { copyFileSync } = await import("node:fs");
copyFileSync(extractedNodePath, binPath);
if (!isWindows) chmodSync(binPath, 0o755);

rmSync(path.join(binDir, distDirName), { recursive: true, force: true });
rmSync(archivePath, { force: true });

console.log(`[fetch-sidecar-node-runtime] Wrote ${binPath}`);
console.log(`[fetch-sidecar-node-runtime] Node ${NODE_VERSION} ready for ${targetTriple}.`);
