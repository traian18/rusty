import React from "react";
import { useShallow } from "zustand/react/shallow";
import { useWorkspaceStore } from "../../store";
import { shouldKeepMounted } from "../../tabs/policy";
import { TabPanel, getTabView, type TabViewContext } from "../../tabs/views";
import { ErrorBoundary } from "../ErrorBoundary";
import { TabCrashFallback } from "./TabCrashFallback";
import styles from "./TabOutlet.module.css";

interface TabOutletProps {
  context: TabViewContext;
}

/**
 * Renders the active tab's panel, plus any kept-mounted tabs parked
 * off-screen so their DOM, sockets and editor state survive while hidden.
 *
 * Extracted from Workspace.tsx's `renderTabPanel`, along with the
 * `keepMountedIds` subscription it depended on. Narrows the re-render blast
 * radius: a tab status change used to re-render all of Workspace (including
 * `executeNode`'s closure); now it re-renders only this component.
 */
export const TabOutlet: React.FC<TabOutletProps> = ({ context }) => {
  const tabs = useWorkspaceStore((state) => state.tabs);
  const activeTabId = useWorkspaceStore((state) => state.activeTabId);
  // Subscribed rather than read imperatively during render: a canvas that
  // starts running while inactive has to re-mount, and a getState() read
  // inside the render loop would never trigger that.
  const keepMountedIds = useWorkspaceStore(
    useShallow((state) =>
      state.tabs.filter((tab) => shouldKeepMounted(tab, state)).map((tab) => tab.id),
    ),
  );

  return (
    <div className={styles.outlet}>
      {tabs.map((tab) => {
        const isActive = tab.id === activeTabId;
        // Inactive tabs unmount unless their policy says otherwise.
        const keepMounted = keepMountedIds.includes(tab.id);
        if (!isActive && !keepMounted) return null;

        const surface = getTabView(tab.type).surface;

        return (
          <div
            key={tab.id}
            className={`${isActive ? styles.active : styles.parked} ${
              surface === "canvas" ? styles.canvasSurface : styles.editorSurface
            }`}
          >
            <ErrorBoundary fallback={(error, reset) => <TabCrashFallback error={error} reset={reset} />}>
              <TabPanel tab={tab} isActive={isActive} context={context} />
            </ErrorBoundary>
          </div>
        );
      })}
    </div>
  );
};
