import { useEffect } from "react";
import { useWorkspaceStore } from "../../store";
import { formatConsoleEntry } from "./consoleFormat";

/**
 * Mirrors console.log/error/warn and uncaught window errors into the Dev
 * Logs terminal tab. Extracted verbatim from App.tsx's console interceptor.
 *
 * Mounted as a sibling of AppBootstrapBoundary, OUTSIDE it, so it captures
 * console output produced during bootstrap -- including the very
 * console.error that would put the boundary into its "failed" state. If this
 * were mounted inside the boundary, a bootstrap failure would be invisible
 * in the Dev Logs tab, which is exactly when you want it visible.
 *
 * Reads `addDevLog` via getState() inside the wrappers rather than
 * subscribing to it, so this effect has `[]` deps and never re-wraps
 * console.* on a re-render.
 *
 * SAFE ONLY AS A SINGLETON: the cleanup restores the pre-wrap originals, so
 * two overlapping instances would wrap recursively and double every log.
 * Mount this once, at the top of the App tree.
 */
export const DevLogBridge: React.FC = () => {
  useEffect(() => {
    const originalLog = console.log;
    const originalError = console.error;
    const originalWarn = console.warn;

    console.log = (...args: any[]) => {
      const text = formatConsoleEntry(args);
      originalLog(text);
      useWorkspaceStore.getState().addDevLog("log", text);
    };

    console.error = (...args: any[]) => {
      const text = formatConsoleEntry(args);
      originalError(text);
      useWorkspaceStore.getState().addDevLog("error", text);
    };

    console.warn = (...args: any[]) => {
      const text = formatConsoleEntry(args);
      originalWarn(text);
      useWorkspaceStore.getState().addDevLog("warn", text);
    };

    const handleWindowError = (event: ErrorEvent) => {
      useWorkspaceStore
        .getState()
        .addDevLog("error", `Uncaught Error: ${event.message} at ${event.filename}:${event.lineno}`);
    };

    const handleUnhandledRejection = (event: PromiseRejectionEvent) => {
      const reason = event.reason;
      const text = reason instanceof Error ? reason.stack || reason.message : String(reason);
      useWorkspaceStore.getState().addDevLog("error", `Unhandled Promise Rejection: ${text}`);
    };

    window.addEventListener("error", handleWindowError);
    window.addEventListener("unhandledrejection", handleUnhandledRejection);

    useWorkspaceStore.getState().addDevLog("system", "Developer Terminal capturing logs.");

    return () => {
      console.log = originalLog;
      console.error = originalError;
      console.warn = originalWarn;
      window.removeEventListener("error", handleWindowError);
      window.removeEventListener("unhandledrejection", handleUnhandledRejection);
    };
  }, []);

  return null;
};
