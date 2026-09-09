import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Deliberately separate from vite.config.ts, which exports an async config
// factory tailored for `tauri dev`/`tauri build` (fixed dev-server port,
// strictPort, HMR wiring). Unit tests should not go through any of that.
export default defineConfig({
  plugins: [react()],
  test: {
    // Non-negotiable: the default include pattern would sweep up the
    // agent-sidecar's node:test files (agent-sidecar/src/**/*.test.ts) and
    // fail trying to run them under vitest.
    include: ["src/**/*.test.{ts,tsx}"],
    // The editor/agent store slices under test are DOM-free and Tauri-free.
    // Running them under a bare node environment enforces that isolation:
    // importing the composed src/store.ts throws immediately here instead of
    // silently succeeding and opening a websocket. Tests that genuinely need
    // a DOM opt in per-file with `// @vitest-environment jsdom`.
    environment: "node",
    globals: false,
    restoreMocks: true,
  },
});
