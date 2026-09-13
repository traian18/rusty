import { useEffect } from "react";
import { useWorkspaceStore } from "../../store";
import { requestCloseTab } from "../../tabs/closeRequests";
import { matchesShortcut } from "../../preferences/shortcuts";

/**
 * Global keyboard shortcuts, extracted verbatim from App.tsx. Also blocks
 * reload (Cmd/Ctrl+R, F5) and devtools (F12, Cmd/Ctrl+Shift+I/J/C,
 * Cmd/Ctrl+Alt+I) and suppresses the right-click context menu app-wide.
 *
 * Mounted in App.tsx OUTSIDE AppBootstrapBoundary, so the reload/devtools
 * suppression stays active during bootstrap and on a bootstrap failure
 * screen. Because Cmd+R is swallowed there too, the failure screen must
 * offer its own explicit Reload button.
 *
 * `keyboardShortcuts` is read live via getState() inside the handler rather
 * than subscribed, so this effect has `[]` deps: the listener registers ONCE
 * for the app's lifetime instead of tearing down and re-registering on every
 * shortcut edit (previously, App.tsx's handler depended on `toggleExplorer`'s
 * identity, which changed on every sidebar width commit -- a keydown
 * arriving during that teardown window was silently dropped). Editing a
 * shortcut in Settings still takes effect immediately, because the handler
 * reads the current value on every keystroke.
 */
export const GlobalShortcuts: React.FC = () => {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();
      const target = e.target instanceof Element ? e.target : null;

      // Shortcut recorders own the keystroke while focused.
      if (target?.closest("[data-shortcut-recorder]")) return;

      // Reload (hard + soft)
      if (mod && key === "r") {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (e.key === "F5") {
        e.preventDefault();
        e.stopPropagation();
        return;
      }

      // DevTools shortcuts
      if (e.key === "F12") {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (mod && e.shiftKey && (key === "i" || key === "j" || key === "c")) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (mod && e.altKey && key === "i") {
        e.preventDefault();
        e.stopPropagation();
        return;
      }

      // View-source (Cmd/Ctrl+U)
      if (mod && key === "u") {
        e.preventDefault();
        e.stopPropagation();
        return;
      }

      const { keyboardShortcuts, activeTabId, setSearchOpen, toggleDrawerView } =
        useWorkspaceStore.getState();

      if (matchesShortcut(e, keyboardShortcuts.closeActiveTab)) {
        e.preventDefault();
        e.stopPropagation();

        if (activeTabId) {
          // Goes through the shared close channel rather than the raw store
          // action, so the unsaved/running guards apply to the keyboard path
          // too. They did not before.
          requestCloseTab(activeTabId);
        }
      } else if (matchesShortcut(e, keyboardShortcuts.openSearch)) {
        e.preventDefault();
        e.stopPropagation();
        setSearchOpen(true);
      } else if (matchesShortcut(e, keyboardShortcuts.toggleExplorer)) {
        e.preventDefault();
        e.stopPropagation();
        toggleDrawerView("explorer");
      }
    };

    // Disable the right-click context menu across the entire application so the
    // user cannot access "Reload", "Inspect Element", or view the UI's HTML.
    const handleContextMenu = (e: MouseEvent) => {
      e.preventDefault();
    };

    window.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("contextmenu", handleContextMenu);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("contextmenu", handleContextMenu);
    };
  }, []);

  return null;
};
