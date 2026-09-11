import { lazy } from "react";
import type { DrawerView } from "../../preferences/shellLayout";

/**
 * Code-split so the drawer is "neither mounted nor loaded until asked for"
 * (REFACTOR_PLAN.md PR 2) -- {drawerOpen && <ContextDrawer/>} alone
 * satisfies "not mounted"; these two lazy() calls are what add "nor
 * loaded". MoveDialog/CreateDialog are imported only by FileTree, so they
 * move into its chunk along with it.
 */
export const LazyFileTree = lazy(() =>
  import("../FileTree").then((module) => ({ default: module.FileTree })),
);

export const LazySourceControl = lazy(() =>
  import("../SourceControl").then((module) => ({ default: module.SourceControl })),
);

/**
 * Prefetch on intent: the rail's Files and Source Control buttons call this
 * on onPointerEnter/onFocus. Vite dedupes the dynamic import(), so calling
 * it repeatedly (every hover, every focus) is a no-op after the first --
 * no bookkeeping needed here. Hover-to-click is typically 100-300ms, well
 * inside which both chunks resolve, so Suspense essentially never fires
 * for a mouse user; only a cold keyboard-triggered open can suspend.
 */
export function preloadDrawerContent(view: DrawerView): void {
  if (view === "explorer") {
    void import("../FileTree");
  } else {
    void import("../SourceControl");
  }
}
