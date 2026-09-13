import React, { cloneElement, isValidElement } from "react";
import styles from "./Tooltip.module.css";

export type TooltipPlacement = "top" | "right" | "bottom" | "left";

export interface TooltipProps {
  /** Stable id; becomes the bubble's id and the trigger's aria-describedby. */
  id: string;
  /** Tooltip text. A DESCRIPTION, not the trigger's accessible name. */
  label: string;
  /** Optional formatted shortcut rendered as a second line, e.g. "⌘1". */
  shortcut?: string;
  placement?: TooltipPlacement;
  children: React.ReactElement<Record<string, unknown>>;
}

/**
 * Promoted from Sidebar.module.css's dock-button tooltip (the one bespoke
 * tooltip pattern in the app before this). Same tokens, two changes:
 *
 * - The bubble wraps the trigger rather than living inside it. The old
 *   pattern put the tooltip <span> inside the <button>, folding its text
 *   into the button's accessible name -- an icon button with both an
 *   aria-label and inline tooltip text announces itself twice. Wrapping
 *   keeps aria-label as the trigger's NAME and the bubble as its
 *   DESCRIPTION via aria-describedby.
 * - A show delay (--motion-tooltip-delay) so hovering across a row of
 *   buttons doesn't pop a tooltip on every one of them; hiding stays
 *   instant.
 */
export const Tooltip: React.FC<TooltipProps> = ({ id, label, shortcut, placement = "top", children }) => {
  const trigger = isValidElement(children)
    ? cloneElement(children, { "aria-describedby": id })
    : children;

  return (
    <span className={styles.wrapper} data-placement={placement}>
      {trigger}
      <span id={id} role="tooltip" className={styles.bubble}>
        {label}
        {shortcut && <kbd className={styles.shortcut}>{shortcut}</kbd>}
      </span>
    </span>
  );
};
