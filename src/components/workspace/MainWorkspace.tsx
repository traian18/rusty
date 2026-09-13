import React from "react";
import { Workspace } from "../Workspace";
import { TerminalPanel } from "../TerminalPanel";
import styles from "./MainWorkspace.module.css";

/**
 * The workspace region's layout owner: the card that hosts the tab strip,
 * tab outlet and the collapsible bottom terminal.
 *
 * This wraps `Workspace.tsx`; it does not absorb it. `executeNode`/
 * `stopExecution` and the run map moved out of `Workspace` into
 * `agentRunCoordinator.ts` (REFACTOR_PLAN.md PR 7 commit 1); `Workspace`
 * still owns the close-intercept modals (commit 3 extracts those too).
 */
export const MainWorkspace: React.FC = () => (
  <div className={styles.workspace}>
    <Workspace />
    <TerminalPanel />
  </div>
);
