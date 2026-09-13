import { Minus, Plus } from "lucide-react";
import { useEffect, useState } from "react";
import styles from "./NumberStepper.module.css";

interface NumberStepperProps {
  id: string;
  decrementId: string;
  incrementId: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  label: string;
  /** Unit shown next to the input and named in its aria-label (e.g. "px",
      "MB"). Defaults to "px" -- every caller before PR 6's
      EditorFileSafetySettings only ever used pixel values. */
  unit?: string;
  onChange: (value: number) => void;
}

export function NumberStepper({
  id,
  decrementId,
  incrementId,
  value,
  min,
  max,
  step = 1,
  label,
  unit = "px",
  onChange,
}: NumberStepperProps) {
  const [draft, setDraft] = useState(String(value));
  const commit = (next: number) => onChange(Math.min(max, Math.max(min, next)));

  useEffect(() => setDraft(String(value)), [value]);

  const commitDraft = () => {
    const next = Number(draft);
    if (Number.isFinite(next)) commit(next);
    else setDraft(String(value));
  };

  return (
    <div className={styles.stepper}>
      <button
        id={decrementId}
        type="button"
        className={styles.button}
        onClick={() => commit(value - step)}
        disabled={value <= min}
        aria-label={`Decrease ${label}`}
      >
        <Minus size={14} />
      </button>
      <div className={styles.inputWrap}>
        <input
          id={id}
          className={styles.input}
          type="number"
          inputMode="numeric"
          value={draft}
          min={min}
          max={max}
          step={step}
          aria-label={`${label} in ${unit === "px" ? "pixels" : unit}`}
          onChange={(event) => setDraft(event.currentTarget.value)}
          onBlur={commitDraft}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              commitDraft();
              event.currentTarget.blur();
            }
          }}
        />
        <span className={styles.unit}>{unit}</span>
      </div>
      <button
        id={incrementId}
        type="button"
        className={styles.button}
        onClick={() => commit(value + step)}
        disabled={value >= max}
        aria-label={`Increase ${label}`}
      >
        <Plus size={14} />
      </button>
    </div>
  );
}
