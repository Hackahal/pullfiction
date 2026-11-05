import { useEffect, useId, useState } from "react";
import { preciseTime } from "./domain";
import { parsePlanTimecode } from "./plan-timecode";

export function PlanTimecodeInput({
  edge,
  value,
  opposite,
  onCommit,
}: {
  edge: "start" | "end";
  value: number | null;
  opposite: number | null;
  onCommit: (value: number | null) => void;
}) {
  const formatted = value === null ? "" : preciseTime(value);
  const [draft, setDraft] = useState(formatted);
  const [error, setError] = useState("");
  const errorId = useId();
  useEffect(() => {
    setDraft(formatted);
    setError("");
  }, [formatted, opposite]);

  function commit() {
    if (draft === formatted) return;
    const parsed = parsePlanTimecode(draft);
    if (!parsed.valid) {
      setError("Use m:ss.mmm or seconds.");
      return;
    }
    const next = parsed.value;
    if (
      next !== null &&
      edge === "start" &&
      opposite !== null &&
      next >= opposite
    ) {
      setError("Start must be before end.");
      return;
    }
    if (next !== null && edge === "end" && next <= (opposite ?? 0)) {
      setError("End must be after start.");
      return;
    }
    setError("");
    setDraft(next === null ? "" : preciseTime(next));
    if (next !== value) onCommit(next);
  }

  return (
    <div className="page-timecode-field">
      <label>
        {edge === "start" ? "Start" : "End"}
        <input
          type="text"
          aria-label={`Step ${edge} timecode`}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          autoComplete="off"
          spellCheck={false}
          placeholder={edge === "start" ? "Beginning" : "End of run"}
          value={draft}
          onChange={(event) => {
            setDraft(event.currentTarget.value);
            setError("");
          }}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              event.stopPropagation();
              commit();
            } else if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              setDraft(formatted);
              setError("");
            }
          }}
        />
      </label>
      {error && (
        <small id={errorId} role="alert">
          {error}
        </small>
      )}
    </div>
  );
}
