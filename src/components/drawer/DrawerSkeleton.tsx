import React from "react";
import styles from "./DrawerSkeleton.module.css";

// Varied widths so it reads as rows of file/folder names rather than a
// single repeated bar.
const ROW_WIDTHS = ["70%", "55%", "82%", "45%", "65%", "50%"];

/**
 * The Suspense fallback for the drawer body. No animation, deliberately:
 * a spinner that flashes for ~30ms (the common case once
 * preloadDrawerContent has warmed the chunk) is worse than a static
 * skeleton matching the eventual layout, and a static skeleton needs no
 * prefers-reduced-motion guard.
 */
export const DrawerSkeleton: React.FC = () => (
  <div className={styles.skeleton} role="status" aria-label="Loading">
    {ROW_WIDTHS.map((width, index) => (
      <div key={index} className={styles.row} style={{ width }} />
    ))}
  </div>
);
