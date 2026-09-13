import {
  DRAWER_DEFAULT_WIDTH,
  loadDrawerWidth,
  saveDrawerWidth,
} from "../../preferences/shellLayout";
import type { WorkspaceSliceCreator } from "../sliceTypes";

/**
 * Application-shell layout: the context drawer (explorer / source control)
 * and the search palette overlay.
 *
 * Replaces four state values that used to live as `useState` in App.tsx
 * (`isSidebarExplorerOpen`, `sidebarView`, `sidebarWidth`, `lastSidebarWidth`)
 * and a toggle rule that was implemented three and a half times, identically,
 * across App.tsx and SidebarPresenter.ts. `toggleDrawerView` below is the
 * single copy.
 */
export const createUiSlice: WorkspaceSliceCreator = (set) => ({
  drawerOpen: false,
  drawerView: "explorer",
  // A constant, never a localStorage read -- slice creators must not do I/O
  // (ARCHITECTURE.md "Slice import-time purity"). hydrateUi() replaces this
  // from the bootstrap boundary.
  drawerWidth: DRAWER_DEFAULT_WIDTH,
  searchOpen: false,

  hydrateUi: () => set({ drawerWidth: loadDrawerWidth() }),

  toggleDrawerView: (view) => set((state) => {
    if (!state.drawerOpen) return { drawerOpen: true, drawerView: view };
    if (state.drawerView === view) return { drawerOpen: false };
    return { drawerView: view };
  }),

  // Distinct from toggleDrawerView: used by the file-reveal flow, which must
  // always land on Explorer regardless of what was open before, and must
  // never close a drawer the user already has open.
  openDrawer: (view) => set({ drawerOpen: true, drawerView: view }),

  closeDrawer: () => set({ drawerOpen: false }),

  setDrawerWidth: (width) => set({ drawerWidth: saveDrawerWidth(width) }),

  setSearchOpen: (searchOpen) => set({ searchOpen }),
});
