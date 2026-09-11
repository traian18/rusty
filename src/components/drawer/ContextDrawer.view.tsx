import React from "react";
import { ChevronLeft, FoldHorizontal, RefreshCw } from "lucide-react";
import { FileTree } from "../FileTree";
import { SourceControl } from "../SourceControl";
import { Tooltip } from "../ui";
import type { DrawerView } from "../../preferences/shellLayout";
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
}) => {
  return (
    <div
      ref={containerRef}
      className={styles.drawer}
      style={{ width: `${drawerWidth}px` }}
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

      <div className={styles.drawerBody}>
        {drawerView === "explorer" ? (
          <div className={styles.explorerContent}>
            {fileTree.length === 0 ? (
              <div className={styles.empty}>
                No workspace loaded.
              </div>
            ) : (
              <FileTree entries={fileTree} />
            )}
          </div>
        ) : (
          <SourceControl />
        )}
      </div>

      <div
        onMouseDown={onResizerMouseDown}
        className={styles.resizer}
      />
    </div>
  );
};
