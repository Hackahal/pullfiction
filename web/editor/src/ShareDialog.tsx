import { useEffect, useRef, useState } from "react";
import type { EditorController } from "./controller";
import {
  ShareClient,
  ownedShares,
  saveOwnedShares,
  shareLink,
  type OwnedShare,
  type SharedSnapshot,
} from "./share-client";
import { Turnstile } from "./Turnstile";

export type ShareTarget = { incoming: string } | { projectId?: string };
const client = new ShareClient();
function storage() {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}
export function ShareDialog({
  controller,
  target,
  close,
  opened,
}: {
  controller: EditorController;
  target: ShareTarget;
  close: () => void;
  opened: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const incoming = "incoming" in target;
  const [snapshot, setSnapshot] = useState<SharedSnapshot | null>(null);
  const [siteKey, setSiteKey] = useState("");
  const [token, setToken] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [created, setCreated] = useState<OwnedShare | null>(null);
  const [owned, setOwned] = useState(() => ownedShares(storage()));
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [recoveryToken, setRecoveryToken] = useState("");
  const [copyId, setCopyId] = useState<string | null>(null);
  const importedId = useRef<string | null>(null);
  useEffect(() => {
    ref.current?.showModal();
    controller.setTyping(true);
    controller.setSceneFocused(false);
    if (
      controller.getSnapshot().playing ||
      controller.getSnapshot().playPreparing
    )
      controller.toggle();
    let disposed = false;
    void (async () => {
      if ("incoming" in target) {
        const value = await client.read(target.incoming);
        if (!disposed) setSnapshot(value);
      } else {
        const value = await controller.projectShareSnapshot(target.projectId);
        if (!disposed) setSnapshot(value);
        const config = await client.config();
        if (!config.enabled || !config.siteKey)
          throw new Error("Sharing is not configured on this deployment.");
        if (!disposed) setSiteKey(config.siteKey);
      }
    })().catch((error) => {
      if (!disposed) setError(error.message);
    });
    return () => {
      disposed = true;
      controller.setTyping(false);
    };
  }, [controller, target]);
  async function publish() {
    if (!snapshot || !token) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await client.publish(snapshot, token);
      const share = { ...result, name: snapshot.plan.name };
      setCreated(share);
      const values = [
        ...new Map(
          [...owned, ...ownedShares(storage()), share].map((value) => [
            value.id,
            value,
          ]),
        ).values(),
      ];
      setOwned(values);
      try {
        const local = storage();
        if (!local) throw new Error();
        saveOwnedShares(values, local);
      } catch {
        setNotice(
          "Link created, but its deletion token could not be saved in this browser. Copy the token below before closing.",
        );
      }
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
      setToken("");
      setAttempt((value) => value + 1);
    }
  }
  async function openCopy() {
    if (!snapshot) return;
    setBusy(true);
    setError("");
    try {
      const id =
        importedId.current ?? (await controller.importSharedSnapshot(snapshot));
      importedId.current = id;
      if (!(await controller.openProject(id)))
        throw new Error(
          controller.getSnapshot().notice || "Could not open the local copy.",
        );
      opened();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function remove(share: OwnedShare) {
    setBusy(true);
    setError("");
    try {
      await client.remove(share.id, share.deleteToken);
      const values = [
        ...new Map(
          [...owned, ...ownedShares(storage())].map((value) => [
            value.id,
            value,
          ]),
        ).values(),
      ].filter((value) => value.id !== share.id);
      setOwned(values);
      if (created?.id === share.id) setCreated(null);
      if (copyId === share.id) setCopyId(null);
      setConfirmDelete(null);
      try {
        const local = storage();
        if (local) saveOwnedShares(values, local);
      } catch {
        setNotice(
          "Share deleted. Its local deletion record could not be cleared.",
        );
      }
      setNotice("Shared link deleted. Existing local copies are unaffected.");
      if ("incoming" in target && target.incoming === share.id)
        setSnapshot(null);
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function copy(id: string) {
    setCopyId(id);
    try {
      await navigator.clipboard.writeText(shareLink(id));
      setNotice("Link copied.");
    } catch {
      setNotice("Select and copy the link below.");
    }
  }
  return (
    <dialog
      ref={ref}
      className="modal share-dialog"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) close();
      }}
    >
      <div className="panel-heading">
        <strong>{incoming ? "Shared plan or run" : "Share plan or run"}</strong>
        <button disabled={busy} aria-label="Close sharing" onClick={close}>
          ×
        </button>
      </div>
      <div className="modal-content">
        {error && <p role="alert">{error}</p>}
        {notice && <p role="status">{notice}</p>}
        {!snapshot && !error && !notice && <p role="status">Loading share…</p>}
        {snapshot && (
          <>
            <h2>{snapshot.plan.name}</h2>
            <p>
              {snapshot.plan.steps.length} pages ·{" "}
              {snapshot.kind === "replay" ? "Run" : "Plan"} ·{" "}
              {snapshot.plan.gameVersion === "sod"
                ? "Season of Discovery"
                : "Classic Era"}
            </p>
            {snapshot.source ? (
              <p>
                Warcraft Logs: {snapshot.source.title || snapshot.source.code} ·{" "}
                {snapshot.source.fight === "run"
                  ? "Full run"
                  : `Encounter ${snapshot.source.fight}`}
                <br />
                Replay data is not included. Connect your own Warcraft Logs
                account and use Reload source to load the run. Report access is
                required.
              </p>
            ) : (
              <p>This plan has no source log.</p>
            )}
            {incoming ? (
              <>
                <p>
                  This is a fixed snapshot. Open a local copy to view or edit it
                  in the editor. Your existing plans are kept.
                </p>
                <button
                  className="gold-button"
                  disabled={busy}
                  onClick={() => void openCopy()}
                >
                  {busy ? "Opening…" : "Open a local copy"}
                </button>
              </>
            ) : (
              !created && (
                <>
                  <p>
                    Anyone with this link can view your plan, including notes
                    and saved actor placements. Replay data and Warcraft Logs
                    credentials are not included.
                  </p>
                  <p>
                    Each link keeps this version. Later edits need a new link.
                    Deletion access is saved in this browser.
                  </p>
                  {siteKey && (
                    <Turnstile
                      siteKey={siteKey}
                      attempt={attempt}
                      onToken={setToken}
                    />
                  )}
                  <button
                    className="gold-button"
                    disabled={!siteKey || !token || busy}
                    onClick={() => void publish()}
                  >
                    {busy ? "Publishing…" : "Create share link"}
                  </button>
                </>
              )
            )}
          </>
        )}
        {created && (
          <section>
            <label>
              Share link
              <input
                aria-label="Created share link"
                readOnly
                value={shareLink(created.id)}
                onFocus={(event) => event.currentTarget.select()}
              />
            </label>
            <button onClick={() => void copy(created.id)}>Copy link</button>
            <details>
              <summary>Keep deletion access</summary>
              <p>
                Keep this token private. Anyone with it can delete the share.
                Clearing browser data removes your saved deletion access.
              </p>
              <label>
                Deletion token
                <input
                  readOnly
                  value={created.deleteToken}
                  onFocus={(event) => event.currentTarget.select()}
                />
              </label>
            </details>
          </section>
        )}
        {copyId && copyId !== created?.id && (
          <label>
            Share link
            <input
              aria-label="Share link to copy"
              readOnly
              value={shareLink(copyId)}
              onFocus={(event) => event.currentTarget.select()}
            />
          </label>
        )}
        {incoming && "incoming" in target && (
          <details>
            <summary>Delete with a saved token</summary>
            <p>
              If you created this share and saved its deletion token, you can
              delete it here.
            </p>
            <label>
              Deletion token
              <input
                type="password"
                autoComplete="off"
                value={recoveryToken}
                onChange={(event) => setRecoveryToken(event.target.value)}
              />
            </label>
            <button
              disabled={busy || !/^[A-Za-z0-9_-]{43}$/.test(recoveryToken)}
              onClick={() => setConfirmDelete(target.incoming)}
            >
              Delete this link
            </button>
            {confirmDelete === target.incoming && (
              <button
                disabled={busy}
                onClick={() =>
                  void remove({
                    id: target.incoming,
                    deleteToken: recoveryToken,
                    name: snapshot?.plan.name ?? "",
                  })
                }
              >
                Confirm delete
              </button>
            )}
          </details>
        )}
        {owned.length > 0 && (
          <section aria-label="Links created in this browser">
            <h3>Your shared links</h3>
            {owned.map((share) => (
              <div key={share.id} className="share-owned">
                <span>{share.name}</span>
                <button disabled={busy} onClick={() => void copy(share.id)}>
                  Copy link
                </button>
                {confirmDelete === share.id ? (
                  <>
                    <button disabled={busy} onClick={() => void remove(share)}>
                      Confirm delete
                    </button>
                    <button
                      disabled={busy}
                      onClick={() => setConfirmDelete(null)}
                    >
                      Cancel
                    </button>
                  </>
                ) : (
                  <button
                    disabled={busy}
                    onClick={() => setConfirmDelete(share.id)}
                  >
                    Delete link
                  </button>
                )}
              </div>
            ))}
          </section>
        )}
      </div>
    </dialog>
  );
}
