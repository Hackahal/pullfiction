import { useState } from "react";
import { MarkEditor, AddPlanPlayer, PageProperties } from "./Planning";
import { EditorIcon } from "./EditorIcon";
import type { EditorController } from "./controller";
import type { Snapshot } from "./types";
export function EditsPanel({
  state,
  controller,
  pageDetails = false,
  onPageDetails,
}: {
  state: Snapshot;
  controller: EditorController;
  pageDetails?: boolean;
  onPageDetails?: (on: boolean) => void;
}) {
  const [query, setQuery] = useState("");
  const hasSelection = !!(
    state.selectedMarks.length || state.selectedActors.length
  );
  const matches = (name: string) =>
    name.toLowerCase().includes(query.trim().toLowerCase());
  return (
    <section
      className="edits-panel"
      aria-label="Edits panel"
      data-input-context="edits"
    >
      <div className="edits-list-toolbar">
        <input
          className="edits-search"
          aria-label="Find edits"
          placeholder="Find edits…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <details className="edits-actions">
          <summary aria-label="Edit actions" title="Edit actions">
            <EditorIcon name="more" />
          </summary>
          <div>
            <button
              onClick={(e) => {
                controller.selectAllMarks();
                e.currentTarget.closest("details")?.removeAttribute("open");
              }}
            >
              Select all
            </button>
            <button
              disabled={!state.selectedMarks.length}
              onClick={(e) => {
                controller.copyMarks();
                e.currentTarget.closest("details")?.removeAttribute("open");
              }}
            >
              Copy drawings
            </button>
            <button
              onClick={(e) => {
                controller.pasteMarks();
                e.currentTarget.closest("details")?.removeAttribute("open");
              }}
            >
              Paste drawings
            </button>
          </div>
        </details>
      </div>
      {state.workspaceMode === "plan" && (
        <AddPlanPlayer controller={controller} />
      )}
      {pageDetails && state.workspaceMode === "plan" ? (
        <div className="edits-properties">
          <PageProperties state={state} controller={controller} />
        </div>
      ) : hasSelection ? (
        <div className="edits-properties">
          <MarkEditor state={state} controller={controller} />
        </div>
      ) : (
        <p className="edits-selection-hint">
          Select an edit to change its properties.
        </p>
      )}
      <div className="edits-outline" aria-label="Saved edits">
        {state.plan.steps.map((page) => {
          const marks = page.annotations.filter((a) =>
              matches(`${a.name} ${a.label} ${a.type}`),
            ),
            actors = (page.snapshot?.actors ?? []).filter((a) =>
              matches(a.name),
            );
          if (!marks.length && !actors.length) return null;
          return (
            <section key={page.id}>
              <div className="edits-page-heading">
                <span>
                  {state.plan.layers.find((l) => l.id === page.layerId)?.name}
                </span>
                <button
                  onClick={() => {
                    controller.setActiveStep(page.id);
                    onPageDetails?.(true);
                  }}
                >
                  {page.name}
                </button>
              </div>
              {marks.map((edit) => (
                <div
                  className={`edit-outline-row ${state.selectedMarks.includes(edit.id) ? "active" : ""}`}
                  key={edit.id}
                >
                  <button
                    className="edit-select"
                    aria-pressed={state.selectedMarks.includes(edit.id)}
                    onClick={(e) => {
                      if (e.shiftKey || e.ctrlKey || e.metaKey)
                        controller.selectMark(edit.id, "toggle");
                      else controller.revealEdit(edit.id);
                    }}
                  >
                    <EditorIcon
                      name={edit.type === "marker" ? "pin" : edit.type}
                    />
                    <span>{edit.name}</span>
                    {edit.actor && <EditorIcon name="actors" />}
                  </button>
                  <button
                    title={edit.hidden ? "Show edit" : "Hide edit"}
                    aria-label={`${edit.hidden ? "Show" : "Hide"} ${edit.name}`}
                    aria-pressed={!edit.hidden}
                    onClick={() => {
                      controller.revealEdit(edit.id);
                      controller.updateMark({ hidden: !edit.hidden });
                    }}
                  >
                    <EditorIcon name="eye" />
                  </button>
                  <button
                    title={edit.locked ? "Unlock edit" : "Lock edit"}
                    aria-label={`${edit.locked ? "Unlock" : "Lock"} ${edit.name}`}
                    aria-pressed={edit.locked}
                    onClick={() => {
                      controller.revealEdit(edit.id);
                      controller.updateMark({ locked: !edit.locked });
                    }}
                  >
                    <EditorIcon name="lock" />
                  </button>
                </div>
              ))}
              {actors.map((actor) => (
                <button
                  key={actor.key}
                  className={`edit-outline-row actor-edit ${state.selectedActors.includes(actor.key) ? "active" : ""}`}
                  onClick={(e) => {
                    controller.revealActorEdit(
                      actor.key,
                      page.id,
                      e.shiftKey || e.ctrlKey || e.metaKey,
                    );
                  }}
                >
                  <EditorIcon
                    name={
                      actor.class === "Boss"
                        ? "skull"
                        : actor.type === "Player"
                          ? "person"
                          : "creature"
                    }
                  />
                  <span>{actor.name}</span>
                  <small>Placement</small>
                </button>
              ))}
            </section>
          );
        })}
        {!state.plan.steps.some(
          (s) => s.annotations.length || s.snapshot?.actors.length,
        ) && (
          <p className="edits-empty">
            Draw in the scene or capture a moment to start a plan.
          </p>
        )}
      </div>
    </section>
  );
}
