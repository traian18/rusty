import React from "react";
import { AppearanceSettings } from "../settings/AppearanceSettings";
import { TypographySettings } from "../settings/TypographySettings";
import { EditorFileSafetySettings } from "../settings/EditorFileSafetySettings";
import { KeyboardShortcutsSettings } from "../settings/KeyboardShortcutsSettings";
import styles from "./SettingsTab.module.css";

export const SettingsTab: React.FC = () => {
  return (
    <div className={styles.page}>
      <div className={styles.content}>
        {/* Title */}
        <div>
          <h2 className={styles.pageTitle}>General Settings</h2>
          <p className={styles.pageDescription}>Personalize Rusty's appearance, text, and keyboard controls.</p>
        </div>

        <div className={styles.panel}><AppearanceSettings /></div>
        <div className={styles.panel}><TypographySettings /></div>
        <div className={styles.panel}><EditorFileSafetySettings /></div>
        <div className={styles.panel}><KeyboardShortcutsSettings /></div>
      </div>
    </div>
  );
};
