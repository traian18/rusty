import React, { RefObject } from "react";
import { X, ChevronDown } from "lucide-react";
import { TabIcon, getTabView } from "../../tabs/views";
import type { TabInstance } from "../../tabs/types";
import styles from "./TabStrip.module.css";

interface TabStripViewProps {
  openTabs: TabInstance[];
  activeTabId: string | null;
  dropdownOpen: boolean;
  setDropdownOpen: (open: boolean) => void;
  activateTab: (tabId: string) => void;
  closeTab: (tabId: string) => void;
  tabsContainerRef: RefObject<HTMLDivElement | null>;
}

export const TabStripView: React.FC<TabStripViewProps> = ({
  openTabs,
  activeTabId,
  dropdownOpen,
  setDropdownOpen,
  activateTab,
  closeTab,
  tabsContainerRef,
}) => {
  return (
    <div className={styles.bar}>
      {/* Scrollable Tab Container */}
      <div ref={tabsContainerRef} className={`${styles.tabs} scrollbar-none tabs-container`}>
        {openTabs.map((tab) => {
          const isActive = tab.id === activeTabId;
          const surface = getTabView(tab.type).surface;

          return (
            <div
              key={tab.id}
              data-tab-id={tab.id}
              onClick={(e) => {
                e.stopPropagation();
                activateTab(tab.id);
              }}
              className={`${styles.tab} ${
                isActive ? (surface === "canvas" ? styles.activeCanvas : styles.activeEditor) : ""
              }`}
            >
              {isActive && <div className={styles.accent} />}

              {/* One registry-driven icon, rather than a per-type chain that
                  silently had no branch for mcp-integration or metrics. */}
              <TabIcon
                tab={tab}
                size={11}
                className={isActive ? styles.iconActive : styles.icon}
              />

              <span className={styles.title}>{tab.title}</span>

              <div className={styles.tabActions}>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTab(tab.id);
                  }}
                  className={styles.iconButton}
                  title="Close tab"
                >
                  <X size={10} />
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {/* Tab Switcher Dropdown */}
      <div className={styles.switcher}>
        <button
          onClick={(e) => {
            e.stopPropagation();
            setDropdownOpen(!dropdownOpen);
          }}
          className={styles.iconButton}
          title="Open Editors"
        >
          <ChevronDown size={14} />
        </button>

        {dropdownOpen && (
          <>
            {/* Click-away backdrop overlay */}
            <div className={styles.backdrop} onClick={() => setDropdownOpen(false)} />
            <div className={styles.menu}>
              <div className={styles.menuTitle}>Open Editors</div>
              {openTabs.map((tab) => {
                const isActive = tab.id === activeTabId;
                return (
                  <div
                    key={tab.id}
                    onClick={() => {
                      activateTab(tab.id);
                      setDropdownOpen(false);
                    }}
                    className={`${styles.menuRow} ${isActive ? styles.menuRowActive : ""}`}
                  >
                    <div className={styles.menuIdentity}>
                      <TabIcon tab={tab} size={11} />
                      <span className={styles.title}>{tab.title}</span>
                    </div>

                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        closeTab(tab.id);
                        if (openTabs.length <= 1) {
                          setDropdownOpen(false);
                        }
                      }}
                      className={`${styles.iconButton} ${styles.menuClose}`}
                    >
                      <X size={10} />
                    </button>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
    </div>
  );
};
