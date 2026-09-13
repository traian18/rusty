#!/bin/bash
# Recursively codesigns every Mach-O binary under the sidecar resource tree
# (native .node addons, vendored CLIs, and any nested .app bundles) with the
# Developer ID identity, hardened runtime, and a secure timestamp. Required
# for notarization: Apple rejects the app if any embedded executable is
# unsigned, ad-hoc signed, or missing the hardened runtime / timestamp.
#
# Claude, Copilot, and the bundled rusty-node runtime itself additionally
# need the JIT entitlements in runtime-entitlements.plist: without them,
# their JIT-compiled JS engines (Bun, V8, and rusty-node's own V8) can't
# reserve executable memory under hardened runtime and crash as soon as
# they're invoked (confirmed via "SharedArrayBuffer is not defined" and
# "Failed to reserve virtual memory for CodeRange" for Claude/Copilot;
# rusty-node's own V8 fails the exact same way, which is what made every
# v0.1.18 sidecar health check fail on a real signed/notarized install even
# though it worked fine from an unsigned local dev build). This runs once,
# before Tauri's own build/notarize step, which never re-signs these files
# afterward - so there's exactly one signing pass.
set -euo pipefail

TARGET_DIR="$1"
IDENTITY="$2"
RUNTIME_ENTITLEMENTS="${3:-}"

if [ -z "$TARGET_DIR" ] || [ -z "$IDENTITY" ]; then
  echo "usage: sign-sidecar-binaries.sh <target-dir> <signing-identity> [runtime-entitlements]" >&2
  exit 1
fi

if [ -n "$RUNTIME_ENTITLEMENTS" ] && [ ! -f "$RUNTIME_ENTITLEMENTS" ]; then
  echo "runtime entitlements not found: $RUNTIME_ENTITLEMENTS" >&2
  exit 1
fi

needs_runtime_entitlements() {
  case "$1" in
    */@anthropic-ai/claude-agent-sdk-darwin-*/claude | \
    */@github/copilot-darwin-*/copilot | \
    */rusty-node)
      return 0
      ;;
  esac
  return 1
}

sign() {
  if [ -n "$RUNTIME_ENTITLEMENTS" ] && needs_runtime_entitlements "$1"; then
    codesign --force --options runtime --timestamp --entitlements "$RUNTIME_ENTITLEMENTS" --sign "$IDENTITY" "$1"
    return
  fi
  codesign --force --options runtime --timestamp --sign "$IDENTITY" "$1"
}

is_macho() {
  file -b "$1" | grep -q "Mach-O"
}

# Nested .app bundles (e.g. GitHub Copilot's "Computer Use" helper) must be
# signed inside-out: their own binaries first, then the bundle itself.
while IFS= read -r -d '' app; do
  while IFS= read -r -d '' bin; do
    if is_macho "$bin"; then
      sign "$bin"
    fi
  done < <(find "$app" -type f -print0)
  sign "$app"
done < <(find "$TARGET_DIR" -type d -name "*.app" -print0 | sort -zr)

# Loose Mach-O files (native addons, vendored binaries) outside any .app bundle.
while IFS= read -r -d '' f; do
  case "$f" in
    *.app/*) continue ;;
  esac
  if is_macho "$f"; then
    sign "$f"
  fi
done < <(find "$TARGET_DIR" -type f -print0)

echo "[sign-sidecar-binaries] done."
