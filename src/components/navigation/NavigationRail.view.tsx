import React from "react";
import { Tooltip } from "../ui";
import { preloadDrawerContent } from "../drawer/drawerContents";
import type {
  NavigationRailIconItem,
  NavigationRailStoreState,
} from "./NavigationRailPresenter";
import styles from "./NavigationRail.module.css";

// The only two rail items that open a lazy-loaded drawer view.
const DRAWER_PRELOAD_IDS = new Set(["explorer", "git"]);

function preloadHandlersFor(id: string) {
  if (!DRAWER_PRELOAD_IDS.has(id)) return {};
  const view = id === "explorer" ? "explorer" : "git";
  const preload = () => preloadDrawerContent(view);
  return { onPointerEnter: preload, onFocus: preload };
}

interface NavigationRailViewProps {
  topIcons: NavigationRailIconItem[];
  helpIcon?: NavigationRailIconItem;
  settingsIcon?: NavigationRailIconItem;
  store: NavigationRailStoreState;
  isItemActive: (id: string) => boolean;
}

export const NavigationRailView: React.FC<NavigationRailViewProps> = ({
  topIcons,
  helpIcon,
  settingsIcon,
  store,
  isItemActive,
}) => {
  return (
    <div className={styles.rail}>
      <div className={styles.railGroup}>
        {topIcons.map((item) => {
          const Icon = item.icon;
          const active = isItemActive(item.id);
          const badge = item.badgeCount ? item.badgeCount(store) : 0;
          const badgeText = item.badgeText?.(store);
          return (
            <Tooltip key={item.id} id={`rail-tooltip-${item.id}`} label={item.label} placement="right">
              <button
                id={`sidebar-${item.id}`}
                type="button"
                onClick={() => item.onClick(store)}
                className={`${styles.railButton} ${active ? styles.railButtonActive : ""}`}
                aria-label={item.label}
                {...preloadHandlersFor(item.id)}
              >
                <Icon size={20} />
                {badge > 0 && (
                  <span className={styles.badge}>
                    {badge}
                  </span>
                )}
                {badgeText && (
                  <span className={styles.badgeText}>
                    {badgeText}
                  </span>
                )}
              </button>
            </Tooltip>
          );
        })}
      </div>

      {/* Bottom General Settings Icon */}
      <div className={`${styles.railGroup} ${styles.railBottom}`}>
        {[helpIcon, settingsIcon].filter((item): item is NavigationRailIconItem => !!item).map((item) => {
          const Icon = item.icon;
          const active = isItemActive(item.id);
          return (
            <Tooltip key={item.id} id={`rail-tooltip-${item.id}`} label={item.label} placement="right">
              <button
                id={`sidebar-${item.id}`}
                type="button"
                onClick={() => item.onClick(store)}
                className={`${styles.railButton} ${active ? styles.railButtonActive : ""}`}
                aria-label={item.label}
                {...preloadHandlersFor(item.id)}
              >
                <Icon size={20} />
              </button>
            </Tooltip>
          );
        })}
      </div>
    </div>
  );
};
