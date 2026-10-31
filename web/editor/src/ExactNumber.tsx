import { useEffect, useRef, useState } from "react";
export function ExactNumber({
  value,
  label,
  min = -20000,
  max = 20000,
  disabled = false,
  onCommit,
}: {
  value: number;
  label: string;
  min?: number;
  max?: number;
  disabled?: boolean;
  onCommit: (value: number) => void;
}) {
  const [draft, setDraft] = useState(String(Math.round(value * 1000) / 1000));
  const editing = useRef(false);
  useEffect(() => {
    if (!editing.current) setDraft(String(Math.round(value * 1000) / 1000));
  }, [value]);
  function reset() {
    setDraft(String(Math.round(value * 1000) / 1000));
  }
  function commit() {
    if (!editing.current) return;
    editing.current = false;
    const n = Number(draft);
    if (draft.trim() && Number.isFinite(n) && n >= min && n <= max) {
      if (n !== value) onCommit(n);
    } else reset();
  }
  return (
    <input
      aria-label={label}
      type="number"
      step=".1"
      min={min}
      max={max}
      disabled={disabled}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onFocus={() => {
        editing.current = true;
      }}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          e.stopPropagation();
          e.currentTarget.blur();
        }
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          editing.current = false;
          reset();
          e.currentTarget.blur();
        }
      }}
    />
  );
}
