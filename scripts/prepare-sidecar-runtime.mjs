import { chmod, copyFile, cp, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { execFileSync } from "node:child_process";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sidecarDir = path.join(rootDir, "agent-sidecar");
const runtimeDir = path.join(rootDir, "src-tauri", "resources", "sidecar");

// The Pi runtime is loaded with dynamic ESM imports, so it cannot be folded into
// server.js by tsup. Copy the installed dependency tree beside the bundled
// server. This also preserves Pi's package-local npm shrinkwrap dependencies.
await rm(runtimeDir, { recursive: true, force: true });
await mkdir(runtimeDir, { recursive: true });

await Promise.all([
  cp(path.join(sidecarDir, "dist", "server.js"), path.join(runtimeDir, "server.js")),
  cp(path.join(sidecarDir, "package.json"), path.join(runtimeDir, "package.json")),
  cp(path.join(sidecarDir, "package-lock.json"), path.join(runtimeDir, "package-lock.json")),
  cp(path.join(sidecarDir, "node_modules"), path.join(runtimeDir, "node_modules"), { recursive: true }),
]);

// Drop devDependencies (tsup/esbuild/rollup/fsevents/ts-node/typescript/...) from the
// shipped copy. They're build-time only, never imported by server.js at runtime, and
// macOS notarization rejects the app if any bundled Mach-O binary is unsigned —
// pruning avoids having to sign build tooling we don't ship on purpose.
// shell: true so Windows resolves npm.cmd (execFileSync won't find bare "npm" there → ENOENT).
execFileSync("npm", ["prune", "--omit=dev"], { cwd: runtimeDir, stdio: "inherit", shell: true });

// Stage the bundled Node binary INSIDE the sidecar resources instead of shipping
// it as a Tauri `externalBin`. externalBin installs to /usr/bin/<name> in the deb,
// which put a second `node` on the system PATH and collided with the distro nodejs
// package. As a resource it lives under the app's private dir (e.g.
// /usr/lib/Rusty-IDE/resources/sidecar/) and is spawned by absolute path — never on
// PATH, no collision. src-tauri/bin/rusty-node-<triple> is downloaded per-platform
// (see BUILD.md / release workflows); pick the one matching this build host.
const targetTriple = (() => {
  const { platform, arch } = process;
  if (platform === "darwin") return arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
  if (platform === "win32") return "x86_64-pc-windows-msvc";
  if (platform === "linux") return arch === "arm64" ? "aarch64-unknown-linux-gnu" : "x86_64-unknown-linux-gnu";
  throw new Error(`[prepare-sidecar-runtime] unsupported platform: ${platform}/${arch}`);
})();
const nodeExt = process.platform === "win32" ? ".exe" : "";
const nodeSrc = path.join(rootDir, "src-tauri", "bin", `rusty-node-${targetTriple}${nodeExt}`);
const nodeDest = path.join(runtimeDir, `rusty-node${nodeExt}`);
if (!existsSync(nodeSrc)) {
  throw new Error(
    `[prepare-sidecar-runtime] bundled node binary not found at ${nodeSrc}. ` +
      "Download it into src-tauri/bin/ first (see BUILD.md).",
  );
}
await copyFile(nodeSrc, nodeDest);
if (process.platform !== "win32") await chmod(nodeDest, 0o755);

// Everything left under node_modules IS shipped and loaded at runtime (native FFI/
// clipboard/terminal addons pulled in by the Copilot/Codex/Pi SDKs). Every Mach-O
// file macOS finds inside the .app must carry a valid Developer ID signature with
// the hardened runtime + secure timestamp, or notarization comes back "Invalid".
const signingIdentity = process.env.APPLE_SIGNING_IDENTITY;
if (signingIdentity) {
  execFileSync(
    path.join(rootDir, "scripts", "sign-sidecar-binaries.sh"),
    [
      runtimeDir,
      signingIdentity,
      path.join(rootDir, "src-tauri", "runtime-entitlements.plist"),
    ],
    { stdio: "inherit" },
  );
} else {
  console.warn(
    "[prepare-sidecar-runtime] APPLE_SIGNING_IDENTITY not set — skipping sidecar codesign. " +
      "Notarization will fail if this build is meant for distribution.",
  );
}
