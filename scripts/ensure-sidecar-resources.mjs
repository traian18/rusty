// Ensures src-tauri/resources/sidecar/ exists before any cargo command runs.
//
// tauri.conf.json declares `"resources": ["resources/sidecar"]`, and
// tauri-build's build script checks for that path's existence unconditionally
// -- for `cargo check`/`cargo test` alike, not just `cargo build` -- even
// though unit tests never read from it. The directory is gitignored (it's a
// built artifact assembled by scripts/prepare-sidecar-runtime.mjs from
// agent-sidecar's build output), so it does not exist on a fresh clone.
//
// Idempotent: does nothing if the directory already exists. Building it from
// scratch (`npm run build:sidecar`) assumes agent-sidecar's own dependencies
// are already installed (`npm --prefix agent-sidecar install`), per BUILD.md.

import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const resourcesDir = path.join(rootDir, "src-tauri", "resources", "sidecar");

if (existsSync(resourcesDir)) {
  console.log("[ensure-sidecar-resources] src-tauri/resources/sidecar already present, skipping.");
  process.exit(0);
}

console.log("[ensure-sidecar-resources] src-tauri/resources/sidecar is missing -- running `npm run build:sidecar`.");
execFileSync("npm", ["run", "build:sidecar"], { cwd: rootDir, stdio: "inherit" });
