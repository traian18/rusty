import React from "react";
import { Header } from "../Header";
import { Sidebar } from "../Sidebar";
import { MainWorkspace } from "../workspace/MainWorkspace";
import { SearchPalette } from "../SearchPalette";
import styles from "./AppShell.module.css";

interface AppShellViewProps {
  searchOpen: boolean;
  onSearchOpen: () => void;
  onSearchClose: () => void;
  onSidebarMouseDown: (e: React.MouseEvent) => void;
  sidebarElementRef: React.RefObject<HTMLDivElement | null>;
}

export const AppShellView: React.FC<AppShellViewProps> = ({
  searchOpen,
  onSearchOpen,
  onSearchClose,
  onSidebarMouseDown,
  sidebarElementRef,
}) => (
  <>
    <Header onSearchOpen={onSearchOpen} />

    <div className={styles.workbench}>
      <Sidebar
        onSidebarMouseDown={onSidebarMouseDown}
        containerRef={sidebarElementRef}
      />
      <MainWorkspace />
    </div>

    {searchOpen && <SearchPalette onClose={onSearchClose} />}
  </>
);
