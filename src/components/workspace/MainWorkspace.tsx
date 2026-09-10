import React from "react";
import { Workspace } from "../Workspace";
import { TerminalPanel } from "../TerminalPanel";
import styles from "./MainWorkspace.module.css";

/**
 * The workspace region's layout owner: the card that hosts the tab strip,
 * tab outlet and the collapsible bottom terminal.
 *
 * This wraps `Workspace.tsx`; it does not absorb it. `Workspace` still owns
 * executeNode/stopExecution, the agent sockets, and the close-intercept
 * modals -- hoisting those into an application service is PR 7's
 * AgentRunCoordinator, not this one.
 */
export const MainWorkspace: React.FC = () => (
  <div className={styles.workspace}>
    <Workspace />
    <TerminalPanel />
  </div>
);
