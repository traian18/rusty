import { RotateCcw } from "lucide-react";
import { EDITOR_FILE_SAFETY_LIMITS } from "../../preferences/editorFileSafety";
import { useWorkspaceStore } from "../../store";
import { Button, NumberStepper } from "../ui";
import styles from "./EditorFileSafetySettings.module.css";

const BYTES_PER_MB = 1024 * 1024;
const limitsMb = {
  min: Math.round(EDITOR_FILE_SAFETY_LIMITS.largeFileThresholdBytes.min / BYTES_PER_MB),
  max: Math.round(EDITOR_FILE_SAFETY_LIMITS.largeFileThresholdBytes.max / BYTES_PER_MB),
  step: Math.round(EDITOR_FILE_SAFETY_LIMITS.largeFileThresholdBytes.step / BYTES_PER_MB),
};

/**
 * REFACTOR_PLAN.md PR 6: the large-file threshold above which FileTab.tsx
 * opens a file read-only with LSP disabled. Stored in bytes
 * (editorFileSafety.largeFileThresholdBytes); this panel is the only place
 * that thinks in MB, converting at the edges.
 */
export function EditorFileSafetySettings() {
  const thresholdBytes = useWorkspaceStore((state) => state.editorFileSafety.largeFileThresholdBytes);
  const setThresholdBytes = useWorkspaceStore((state) => state.setLargeFileThresholdBytes);
  const reset = useWorkspaceStore((state) => state.resetEditorFileSafety);

  return (
    <section className={styles.section} aria-labelledby="editor-file-safety-title">
      <div className={styles.heading}>
        <div>
          <h3 className={styles.title} id="editor-file-safety-title">Large file handling</h3>
          <p className={styles.description}>
            Files above this size open read-only, with the language server disabled, instead of the normal editable path.
          </p>
        </div>
        <Button id="editor-file-safety-reset" variant="ghost" icon={<RotateCcw size={13} />} onClick={reset}>
          Reset
        </Button>
      </div>
      <div className={styles.card}>
        <div>
          <label className={styles.label} htmlFor="editor-file-safety-threshold">Large-file threshold</label>
          <p className={styles.hint}>A binary file always gets an unsupported-file preview instead, regardless of size.</p>
        </div>
        <NumberStepper
          id="editor-file-safety-threshold"
          decrementId="editor-file-safety-threshold-decrement"
          incrementId="editor-file-safety-threshold-increment"
          label="Large-file threshold"
          unit="MB"
          value={Math.round(thresholdBytes / BYTES_PER_MB)}
          min={limitsMb.min}
          max={limitsMb.max}
          step={limitsMb.step}
          onChange={(mb) => setThresholdBytes(mb * BYTES_PER_MB)}
        />
      </div>
    </section>
  );
}
