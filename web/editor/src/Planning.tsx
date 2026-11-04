import { tacticalMarker } from "./icon-fallbacks";
import { GameIcon } from "./GameIcon";
import { AttachmentControl } from "./AttachmentControl";
import { ExactNumber } from "./ExactNumber";
import { PlanTimecodeInput } from "./PlanTimecodeInput";
import { planRangeLabel } from "./plan-timecode";
import { EditorIcon } from "./EditorIcon";
import { useState, useEffect } from "react";
import type { EditorController } from "./controller";
import type { Annotation, PlanStep, Snapshot } from "./types";
import { preciseTime } from "./domain";
import { RAID_ICONS } from "./annotation-model";
export function MarkIcon({ icon }: { icon: string }) {
  if (/^[1-8]$/.test(icon)) {
    const i = Number(icon) - 1;
    return (
      <span
        className="plan-raid-icon"
        aria-label={RAID_ICONS[i]}
        style={{
          backgroundPosition: `${((i % 4) * 100) / 3}% ${(Math.floor(i / 4) * 100) / 3}%`,
        }}
      />
    );
  }
  return (
    <GameIcon
      className="plan-game-icon"
      name={icon}
      fallbackSrc={tacticalMarker(icon)?.fallback}
    />
  );
}
export function PageProperties({
  state,
  controller,
}: {
  state: Snapshot;
  controller: EditorController;
}) {
  const step =
    state.plan.steps.find((s) => s.id === state.activeStep) ??
    state.plan.steps[0];
  return (
    <aside
      className="page-properties"
      data-input-context="playbook"
      aria-label="Page properties"
    >
      <header className="page-identity">
        <label className="page-navigation">
          <span>Current page</span>
          <select
            aria-label="Current page"
            value={step.id}
            onChange={(e) => controller.setActiveStep(e.target.value, false)}
          >
            {state.plan.layers.map((layer) => (
              <optgroup key={layer.id} label={layer.name}>
                {state.plan.steps
                  .filter((page) => page.layerId === layer.id)
                  .map((page) => (
                    <option key={page.id} value={page.id}>
                      {page.name}
                    </option>
                  ))}
              </optgroup>
            ))}
          </select>
        </label>
        {step.snapshot && (
          <dl className="page-source-facts" aria-label="Recorded capture">
            <div>
              <dt>Captured at</dt>
              <dd>
                <time>{preciseTime(step.snapshot.time)}</time>
              </dd>
            </div>
            <div>
              <dt>Recorded placements</dt>
              <dd>{step.snapshot.actors.length.toLocaleString()}</dd>
            </div>
          </dl>
        )}
      </header>
      <div className="page-name-fields">
        <label>
          Page name
          <input
            aria-label="Step name"
            value={step.name}
            maxLength={100}
            onChange={(e) => controller.updateStep({ name: e.target.value })}
          />
        </label>
        <label>
          Type
          <select
            aria-label="Step type"
            value={step.kind}
            onChange={(e) =>
              controller.updateStep({
                kind: e.target.value as PlanStep["kind"],
              })
            }
          >
            {["pull", "boss", "phase", "route", "note"].map((k) => (
              <option key={k}>{k}</option>
            ))}
          </select>
        </label>
        <label>
          Layer
          <select
            aria-label="Page layer"
            value={step.layerId}
            onChange={(e) => controller.updateStep({ layerId: e.target.value })}
          >
            {state.plan.layers.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      {state.replay && (
        <details className="page-timing">
          <summary>
            <span>
              <strong>Replay timing</strong>
              <span className="page-timing-range">
                {planRangeLabel(step.start, step.end)}
              </span>
            </span>
            <EditorIcon name="down" />
          </summary>
          <div className="page-timing-editor">
            <div className="page-timing-fields" key={step.id}>
              <PlanTimecodeInput
                edge="start"
                value={step.start}
                opposite={step.end}
                onCommit={(start) => controller.updateStep({ start })}
              />
              <PlanTimecodeInput
                edge="end"
                value={step.end}
                opposite={step.start}
                onCommit={(end) => controller.updateStep({ end })}
              />
            </div>
            <small className="page-timing-hint">
              Use m:ss.mmm. Leave a field blank for an open bound.
            </small>
            <div className="page-timing-actions">
              <button
                title="Set step start to playhead"
                disabled={!state.replay}
                onClick={() =>
                  controller.updateStep({
                    start: state.time,
                    end:
                      step.end !== null && step.end <= state.time
                        ? null
                        : step.end,
                  })
                }
              >
                Set start at playhead
              </button>
              <button
                title="Set step end to playhead"
                disabled={!state.replay || state.time <= (step.start ?? 0)}
                onClick={() => controller.updateStep({ end: state.time })}
              >
                Set end at playhead
              </button>
              <button
                title="Remove time link"
                disabled={step.start === null && step.end === null}
                onClick={() =>
                  controller.updateStep({ start: null, end: null })
                }
              >
                Clear timing
              </button>
            </div>
          </div>
        </details>
      )}
      <label className="page-notes">
        Notes
        <textarea
          aria-label="Step notes"
          placeholder="Pull instructions, assignments…"
          value={step.notes}
          maxLength={4000}
          onChange={(e) => controller.updateStep({ notes: e.target.value })}
        />
      </label>
      <div className="planning-actions">
        <button
          title="Move step earlier"
          aria-label="Move step earlier"
          onClick={() => controller.moveStep(-1)}
        >
          <EditorIcon name="up" />
        </button>
        <button
          title="Move step later"
          aria-label="Move step later"
          onClick={() => controller.moveStep(1)}
        >
          <EditorIcon name="down" />
        </button>
        <button
          aria-label="Duplicate step"
          onClick={() => controller.duplicateStep()}
        >
          Duplicate
        </button>
        <button
          disabled={state.plan.steps.length === 1}
          aria-label="Delete step"
          onClick={() => controller.deleteStep()}
        >
          Delete
        </button>
      </div>
    </aside>
  );
}
export function AddPlanPlayer({
  controller,
}: {
  controller: EditorController;
}) {
  const [actorName, setActorName] = useState("");
  const [actorClass, setActorClass] = useState("Warrior");
  return (
    <details className="plan-add-actor">
      <summary>Add player</summary>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          controller.addPlanActor(actorName, actorClass);
          setActorName("");
        }}
      >
        <input
          aria-label="Planned player name"
          placeholder="Player name"
          maxLength={120}
          value={actorName}
          onChange={(e) => setActorName(e.target.value)}
        />
        <select
          aria-label="Planned player class"
          value={actorClass}
          onChange={(e) => setActorClass(e.target.value)}
        >
          {[
            "Warrior",
            "Paladin",
            "Hunter",
            "Rogue",
            "Priest",
            "Shaman",
            "Mage",
            "Warlock",
            "Druid",
          ].map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
        <button disabled={!actorName.trim()}>
          <EditorIcon name="actors" /> Add
        </button>
      </form>
    </details>
  );
}
export function MarkEditor({
  state,
  controller,
}: {
  state: Snapshot;
  controller: EditorController;
}) {
  const [comment, setComment] = useState("");
  const step =
    state.plan.steps.find((s) => s.id === state.activeStep) ??
    state.plan.steps[0];
  const selected = step.annotations.find((a) => a.id === state.selectedMark);
  const selectedActor = step.snapshot?.actors.find((a) =>
    state.selectedActors.includes(a.key),
  );
  useEffect(() => setComment(""), [selected?.id]);
  const multi = state.selectedMarks.length > 1;
  const update = (patch: Partial<Annotation>) =>
    selected ? controller.updateMark(patch) : controller.setMarkStyle(patch);
  return (
    <section className="mark-editor planning-scroll" aria-label="Mark editor">
      <div className="planning-section">
        <strong>
          {multi
            ? `${state.selectedMarks.length} selected`
            : selected
              ? selected.name
              : selectedActor
                ? state.selectedActors.length > 1
                  ? `${state.selectedActors.length} actors selected`
                  : selectedActor.name
                : "Drawing style"}
        </strong>
        {selected && (
          <button onClick={() => controller.selectMark(null)}>Deselect</button>
        )}
      </div>
      {(selected || selectedActor || multi) && (
        <details className="planning-advanced">
          <summary>Position and transform</summary>
          {selectedActor && state.compareRecorded && (
            <p className="placement-source">
              {selectedActor.name}:{" "}
              {selectedActor.recorded
                ? "recorded position"
                : "no recorded position · showing planned placement"}
            </p>
          )}
          {selectedActor && (
            <div className="plan-form-row">
              {([0, 1] as const).map((axis) => (
                <label key={axis}>
                  {axis === 0 ? "X" : "Y"} yd
                  <ExactNumber
                    label={`Actor ${axis === 0 ? "X" : "Y"} yards`}
                    value={
                      (state.compareRecorded
                        ? selectedActor.recorded
                        : undefined)?.[axis] ?? selectedActor.position[axis]
                    }
                    onCommit={(n) => controller.positionActors(axis, n)}
                    disabled={state.compareRecorded}
                  />
                </label>
              ))}
            </div>
          )}
          {selected && !multi && (
            <div className="plan-form-row">
              {([0, 1] as const).map((axis) => (
                <label key={axis}>
                  {axis === 0 ? "X" : "Y"} yd
                  <ExactNumber
                    label={`${axis === 0 ? "X" : "Y"} yards`}
                    value={selected.points[0][axis]}
                    disabled={selected.locked}
                    onCommit={(n) =>
                      controller.nudgeMarks(
                        axis === 0 ? n - selected.points[0][0] : 0,
                        axis === 1 ? n - selected.points[0][1] : 0,
                      )
                    }
                  />
                </label>
              ))}
            </div>
          )}
          {(state.selectedMarks.length > 0 ||
            state.selectedActors.length > 0) && (
            <div className="plan-form-row">
              <label>
                Rotate °
                <input
                  aria-label="Rotate selection degrees"
                  type="number"
                  defaultValue="0"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      controller.transformSelection(
                        Number(e.currentTarget.value),
                      );
                      e.currentTarget.value = "0";
                    }
                  }}
                />
              </label>
              <label>
                Scale ×
                <input
                  aria-label="Scale selection"
                  type="number"
                  min=".05"
                  max="20"
                  step=".1"
                  defaultValue="1"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      controller.transformSelection(
                        0,
                        Number(e.currentTarget.value),
                      );
                      e.currentTarget.value = "1";
                    }
                  }}
                />
              </label>
            </div>
          )}
        </details>
      )}
      {multi && (
        <div className="planning-actions">
          <button onClick={() => controller.duplicateMark()}>
            Duplicate selection
          </button>
          <button onClick={() => controller.removeMark()}>
            Delete selection
          </button>
          <button onClick={() => controller.updateMark({ locked: true })}>
            Lock
          </button>
          <button onClick={() => controller.updateMark({ locked: false })}>
            Unlock
          </button>
        </div>
      )}
      {selected && !multi && (
        <>
          <label>
            Edit name
            <input
              aria-label="Edit name"
              value={selected.name}
              maxLength={120}
              onChange={(e) => update({ name: e.target.value })}
            />
          </label>
          <AttachmentControl
            edit={selected}
            state={state}
            controller={controller}
          />
          <input
            aria-label="Mark label"
            placeholder="Label / assignment"
            disabled={selected.locked}
            value={selected.label}
            maxLength={120}
            onChange={(e) => update({ label: e.target.value })}
          />
          <textarea
            aria-label="Mark notes"
            placeholder="Notes"
            disabled={selected.locked}
            value={selected.notes}
            maxLength={4000}
            onChange={(e) => update({ notes: e.target.value })}
          />
          <div className="planning-actions edit-actions">
            <button
              disabled={selected.locked}
              onClick={() => controller.setTransform("move")}
            >
              Move handles
            </button>
            <button onClick={() => controller.duplicateMark()}>
              Duplicate
            </button>
            <button
              disabled={selected.locked}
              onClick={() => controller.removeMark()}
            >
              Delete
            </button>
          </div>
          <div className="plan-step-options">
            <label>
              <input
                type="checkbox"
                checked={selected.locked}
                onChange={(e) =>
                  controller.updateMark({ locked: e.target.checked })
                }
              />
              Locked
            </label>
            <label>
              <input
                type="checkbox"
                checked={selected.hidden}
                disabled={selected.locked}
                onChange={(e) => update({ hidden: e.target.checked })}
              />
              Hidden
            </label>
          </div>
          <div className="planning-section">
            <strong>Comments</strong>
            <span>{selected.comments.length}</span>
          </div>
          <div className="plan-comments">
            {selected.comments.map((c) => (
              <p key={c.id}>
                {c.text}
                <time>{new Date(c.createdAt).toLocaleString()}</time>
              </p>
            ))}
          </div>
          <form
            className="plan-comment-form"
            onSubmit={(e) => {
              e.preventDefault();
              controller.comment(comment);
              setComment("");
            }}
          >
            <textarea
              aria-label="New comment"
              value={comment}
              maxLength={2000}
              placeholder="Add a comment…"
              disabled={selected.locked}
              onChange={(e) => setComment(e.target.value)}
            />
            <button disabled={!comment.trim() || selected.locked}>
              Add comment
            </button>
          </form>
        </>
      )}
    </section>
  );
}
