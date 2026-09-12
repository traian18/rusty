import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { ThemeRuntime } from "./components/ThemeRuntime";
import { TypographyRuntime } from "./components/runtime/TypographyRuntime";
import { applyThemeProperties, resolveTheme } from "./theme";
import { applyTypographyProperties } from "./preferences/typography";
import { useWorkspaceStore } from "./store";
import "./index.css";

// Slices initialize activeThemeId/typographyPreferences/keyboardShortcuts
// from constants, never from localStorage at creation time (ARCHITECTURE.md's
// "slice import-time purity" rule) -- these hydrate actions do the actual
// localStorage reads, called here, synchronously, before createRoot, so the
// pre-paint theme/typography apply below keeps working exactly as it did
// when those reads happened inline at slice creation. No FOUC risk: nothing
// async is introduced onto this path (REFACTOR_PLAN.md PR 3a).
const store = useWorkspaceStore.getState();
store.hydrateTheme();
store.hydrateTypography();
store.hydrateShortcuts();

const hydratedState = useWorkspaceStore.getState();
applyThemeProperties(resolveTheme(hydratedState.activeThemeId));
applyTypographyProperties(hydratedState.typographyPreferences);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <ThemeRuntime />
      <TypographyRuntime />
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
