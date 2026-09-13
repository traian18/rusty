// Ensures src-tauri/resources/sidecar/ exists AND is complete before any
// cargo command runs, or before the app tries to spawn the sidecar.
//
// tauri.conf.json declares `"resources": ["resources/sidecar"]`, and
// tauri-build's build script checks for that path's existence unconditionally
// -- for `cargo check`/`cargo test` alike, not just `cargo build` -- even
// though unit tests never read from it. The directory is gitignored (it's a
// built artifact assembled by scripts/prepare-sidecar-runtime.mjs from
// agent-sidecar's build output), so it does not exist on a fresh clone.
//
// Checks for the platform's bundled `rusty-node[.exe]` binary inside the
// directory, not just the directory's own existence: a directory built by an
// older prepare-sidecar-runtime.mjs (from before that script started staging
// a node binary into resources/sidecar at all, or under its old `node-*`
// name) would otherwise pass an existence-only check while still being
// missing exactly what spawn_sidecar (src-tauri/src/lib.rs) needs to launch
// the sidecar -- a real, hit-in-practice bug, not a hypothetical one.
//
// Idempotent: does nothing if a complete directory already exists. Building
// it from scratch (`npm run build:sidecar`) assumes agent-sidecar's own
// dependencies are already installed (`npm --prefix agent-sidecar install`),
// per BUILD.md.

import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const resourcesDir = path.join(rootDir, "src-tauri", "resources", "sidecar");
const nodeBinaryName = process.platform === "win32" ? "rusty-node.exe" : "rusty-node";
const nodeBinaryPath = path.join(resourcesDir, nodeBinaryName);

if (existsSync(resourcesDir) && existsSync(nodeBinaryPath)) {
  console.log("[ensure-sidecar-resources] src-tauri/resources/sidecar already present and complete, skipping.");
  process.exit(0);
}

console.log(
  existsSync(resourcesDir)
    ? `[ensure-sidecar-resources] src-tauri/resources/sidecar exists but is missing ${nodeBinaryName} -- rebuilding via \`npm run build:sidecar\`.`
    : "[ensure-sidecar-resources] src-tauri/resources/sidecar is missing -- running `npm run build:sidecar`.",
);
execFileSync("npm", ["run", "build:sidecar"], { cwd: rootDir, stdio: "inherit" });
