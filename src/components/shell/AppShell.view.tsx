import React from "react";
import { Header } from "../Header";
import { NavigationRail } from "../navigation/NavigationRail";
import { ContextDrawer } from "../drawer/ContextDrawer";
import { MainWorkspace } from "../workspace/MainWorkspace";
import { SearchPalette } from "../SearchPalette";
import styles from "./AppShell.module.css";

interface AppShellViewProps {
  searchOpen: boolean;
  onSearchOpen: () => void;
  onSearchClose: () => void;
  drawerOpen: boolean;
  onDrawerResizeMouseDown: (e: React.MouseEvent) => void;
  drawerElementRef: React.RefObject<HTMLDivElement | null>;
}

export const AppShellView: React.FC<AppShellViewProps> = ({
  searchOpen,
  onSearchOpen,
  onSearchClose,
  drawerOpen,
  onDrawerResizeMouseDown,
  drawerElementRef,
}) => (
  <>
    <Header onSearchOpen={onSearchOpen} />

    <div className={styles.workbench}>
      <NavigationRail />

      {/*
        The single shell card. `overflow: hidden` is what lets the rail's
        right-placed tooltips escape into the gutter (it sits outside this
        element) while still clipping the drawer and workspace to one
        rounded rectangle -- see NavigationRail.module.css's matching note.
      */}
      <div className={styles.surface}>
        {drawerOpen && (
          <ContextDrawer
            containerRef={drawerElementRef}
            onResizerMouseDown={onDrawerResizeMouseDown}
          />
        )}
        <MainWorkspace />
      </div>
    </div>

    {searchOpen && <SearchPalette onClose={onSearchClose} />}
  </>
);
