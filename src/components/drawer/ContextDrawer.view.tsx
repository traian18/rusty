import React, { Suspense } from "react";
import { ChevronLeft, FoldHorizontal, RefreshCw } from "lucide-react";
import { LazyFileTree, LazySourceControl } from "./drawerContents";
import { DrawerSkeleton } from "./DrawerSkeleton";
import { Tooltip } from "../ui";
import { DRAWER_MIN_WIDTH, DRAWER_MAX_WIDTH, type DrawerView } from "../../preferences/shellLayout";
import styles from "./ContextDrawer.module.css";

interface ContextDrawerViewProps {
  drawerView: DrawerView;
  drawerWidth: number;
  fileTree: any[];
  containerRef?: React.RefObject<HTMLDivElement | null>;
  handleRefreshExplorer: () => void;
  handleCollapseAllFolders: () => void;
  handleCollapseDrawer: () => void;
  onResizerMouseDown: (e: React.MouseEvent) => void;
  onResizerKeyDown: (e: React.KeyboardEvent) => void;
  onDrawerKeyDown: (e: React.KeyboardEvent) => void;
}

export const ContextDrawerView: React.FC<ContextDrawerViewProps> = ({
  drawerView,
  drawerWidth,
  fileTree,
  containerRef,
  handleRefreshExplorer,
  handleCollapseAllFolders,
  handleCollapseDrawer,
  onResizerMouseDown,
  onResizerKeyDown,
  onDrawerKeyDown,
}) => {
  return (
    <div
      ref={containerRef}
      className={styles.drawer}
      // --drawer-width, not a `width` inline style: ContextDrawer.module.css's
      // `width: var(--drawer-width)` rule is what applies it, in both docked
      // and narrow-shell overlay mode. The cast is needed because React 19's
      // CSSProperties still rejects custom properties.
      style={{ "--drawer-width": `${drawerWidth}px` } as React.CSSProperties}
      onKeyDown={onDrawerKeyDown}
    >
      {/* Header lives outside .drawerBody's scroller so its tooltips and
          the sticky-header clipping bug (old Sidebar.view.tsx) can't recur. */}
      <div className={styles.drawerHeader}>
        <span className={styles.title}>
          {drawerView === "explorer" ? "Project Explorer" : "Source Control"}
        </span>
        <div className={styles.tools}>
          {drawerView === "explorer" && (
            <>
              <Tooltip id="explorer-refresh-tooltip" label="Refresh Explorer" placement="bottom">
                <button
                  id="explorer-refresh"
                  type="button"
                  onClick={handleRefreshExplorer}
                  className={styles.toolButton}
                  aria-label="Refresh Explorer"
                >
                  <RefreshCw size={12} />
                </button>
              </Tooltip>
              <Tooltip id="explorer-collapse-all-tooltip" label="Collapse All Folders" placement="bottom">
                <button
                  id="explorer-collapse-all"
                  type="button"
                  onClick={handleCollapseAllFolders}
                  className={styles.toolButton}
                  aria-label="Collapse All Folders"
                >
                  <FoldHorizontal size={12} />
                </button>
              </Tooltip>
            </>
          )}
          <Tooltip id="drawer-collapse-tooltip" label="Collapse Sidebar" placement="bottom">
            <button
              id="explorer-collapse-sidebar"
              type="button"
              onClick={handleCollapseDrawer}
              className={styles.toolButton}
              aria-label="Collapse Sidebar"
            >
              <ChevronLeft size={12} />
            </button>
          </Tooltip>
        </div>
      </div>

      {/* Suspense wraps only the body -- the header and close button paint
          on the frame the drawer opens; only the tree/status content shows
          a fallback. preloadDrawerContent (rail hover/focus) means this
          essentially never suspends for a mouse user. */}
      <div className={styles.drawerBody}>
        <Suspense fallback={<DrawerSkeleton />}>
          {drawerView === "explorer" ? (
            <div className={styles.explorerContent}>
              {fileTree.length === 0 ? (
                <div className={styles.empty}>
                  No workspace loaded.
                </div>
              ) : (
                <LazyFileTree entries={fileTree} />
              )}
            </div>
          ) : (
            <LazySourceControl />
          )}
        </Suspense>
      </div>

      <div
        onMouseDown={onResizerMouseDown}
        onKeyDown={onResizerKeyDown}
        className={styles.resizer}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize drawer"
        aria-valuenow={drawerWidth}
        aria-valuemin={DRAWER_MIN_WIDTH}
        aria-valuemax={DRAWER_MAX_WIDTH}
        tabIndex={0}
      />
    </div>
  );
};
