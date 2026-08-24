import { type DragEvent, useEffect, useMemo, useRef, useState } from "react";
import { useLocation as useLocationDefault } from "react-router";

export const importPanelSeams = {
  useLocation: useLocationDefault,
};
import {
  IconAlert,
  IconCard,
  IconCheck,
  IconInfo,
  IconLock,
  IconLogin,
  IconNote,
  IconPasskey,
  IconSecret,
  IconUpload,
  IconX,
} from "../../components/Icons.js";
import { useVault, useVaultStore } from "../../lib/vault/hooks.js";
import {
  ADAPTERS,
  type ParseResult,
  type SourceId,
  adapterFor,
  parseImportAsync,
  readImportFile,
  summarise,
} from "../../lib/vault/import/index.js";
import {
  type MergeOptions,
  defaultMergeOptions,
  planMerge,
} from "../../lib/vault/import/merge.js";
import type { DetectInput } from "../../lib/vault/import/types.js";
import type { VaultItem } from "../../lib/vault/model.js";
import "./import.css";
import { overlapCast } from "@opensesame/os-domain";

/** Rows rendered in the preview before it collapses to a count. */
const PREVIEW_LIMIT = 60;

/**
 * `ADAPTERS` is ordered by detection priority, which is meaningless to someone
 * hunting for their own product. Reading order is by product name, with the
 * registry's order kept within a product so the richer format is listed first.
 */
const LISTED = ADAPTERS.map((adapter, index) => ({ adapter, index }))
  .sort(
    (a, b) =>
      productOf(a.adapter.label).localeCompare(productOf(b.adapter.label)) ||
      a.index - b.index,
  )
  .map(({ adapter }) => adapter);

function productOf(label: string): string {
  return label.split(" (")[0] ?? label;
}

type Stage =
  | { step: "idle" }
  | { step: "reading"; fileName: string }
  /**
   * Read fine, but no adapter would claim it. The parsed file is kept so the
   * user can name the format themselves instead of starting over.
   */
  | { step: "failed"; fileName: string; file: DetectInput }
  /**
   * An encrypted database that has not been opened yet. The bytes are held in
   * `file`; the password lives in a field on this screen for exactly as long
   * as it takes to decrypt, and is never put in state that outlives it.
   */
  | {
      step: "locked";
      fileName: string;
      file: DetectInput;
      source: SourceId;
      note: string;
    }
  | {
      step: "preview";
      fileName: string;
      file: DetectInput;
      result: ParseResult;
    }
  | { step: "done"; added: number; skipped: number };

const KIND_ICON = {
  login: IconLogin,
  passkey: IconPasskey,
  card: IconCard,
  note: IconNote,
  secret: IconSecret,
} as const;

function messageFrom<Thrown>(caught: Thrown): string {
  return caught instanceof Error
    ? caught.message
    : "That file could not be read.";
}

export function ImportPanel() {
  const { items, folders } = useVault();
  const store = useVaultStore();

  const [stage, setStage] = useState<Stage>({ step: "idle" });
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [options, setOptions] = useState<MergeOptions>(defaultMergeOptions);
  const [folderMode, setFolderMode] = useState<"keep" | "single" | "none">(
    "keep",
  );
  const [singleFolder, setSingleFolder] = useState("");
  /**
   * The master password of an encrypted database being opened. It is cleared
   * the moment the file is read, and never leaves this component.
   */
  const [password, setPassword] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const { hash } = importPanelSeams.useLocation();

  // The vault's empty state links here with #import. React Router does not act
  // on a hash, so the panel brings itself into view.
  useEffect(() => {
    if (hash !== "#import") return;
    panelRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [hash]);

  const result = stage.step === "preview" ? stage.result : null;

  const summary = useMemo(
    () => (result ? summarise(result.items) : null),
    [result],
  );

  // The plan is recomputed as options change so the confirm button can state
  // the real number, and duplicates can be counted before anything is written.
  const plan = useMemo(() => {
    if (!result) return null;
    const merge: MergeOptions = {
      intoFolder:
        folderMode === "single"
          ? singleFolder.trim() || defaultFolderName(result.source)
          : null,
      keepFolders: folderMode === "keep",
      skipDuplicates: options.skipDuplicates,
    };
    return planMerge(result.items, items, folders, merge);
  }, [
    result,
    items,
    folders,
    folderMode,
    singleFolder,
    options.skipDuplicates,
  ]);

  // The preview names the folder each item will actually land in, which for a
  // fresh import is usually one that does not exist yet.
  const folderNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const folder of [...folders, ...(plan?.newFolders ?? [])]) {
      map.set(folder.id, folder.name);
    }
    return map;
  }, [folders, plan]);

  function reset() {
    setStage({ step: "idle" });
    setError(null);
    setOptions(defaultMergeOptions);
    setFolderMode("keep");
    setSingleFolder("");
    setPassword("");
    if (fileRef.current) fileRef.current.value = "";
  }

  /**
   * A parse either produced a preview or asked for the password to the blob it
   * was given. Both answers land here so there is one place that decides what
   * the screen shows next.
   */
  function show(fileName: string, file: DetectInput, next: ParseResult) {
    if (next.needsPassword === true) {
      setStage({
        step: "locked",
        fileName,
        file,
        source: next.source,
        note: next.warnings[0] ?? "",
      });
      return;
    }
    setStage({ step: "preview", fileName, file, result: next });
    adoptDefaults(next);
  }

  async function readFile(file: File) {
    setError(null);
    setPassword("");
    setStage({ step: "reading", fileName: file.name });
    let parsed: DetectInput;
    try {
      parsed = await readImportFile(file);
    } catch (caught) {
      // The file could not even be read — an archive we cannot open, or
      // something far too large. There is nothing to offer a format for.
      setError(messageFrom(caught));
      setStage({ step: "idle" });
      if (fileRef.current) fileRef.current.value = "";
      return;
    }

    try {
      show(file.name, parsed, await parseImportAsync(parsed));
    } catch (caught) {
      setError(messageFrom(caught));
      setStage({ step: "failed", fileName: file.name, file: parsed });
    } finally {
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  /** Decrypt the database already in hand with the password just typed. */
  async function unlock() {
    if (stage.step !== "locked" || password === "") return;
    setError(null);
    setBusy(true);
    try {
      const next = await parseImportAsync(
        { ...stage.file, password },
        stage.source,
      );
      setPassword("");
      show(stage.fileName, stage.file, next);
    } catch (caught) {
      setError(messageFrom(caught));
    } finally {
      setBusy(false);
    }
  }

  /**
   * Pick the folder handling that suits what was actually found. An export
   * with folders should keep them; one without (every browser) is better off
   * gathered under one name the user can find again.
   */
  function adoptDefaults(parsed: ParseResult) {
    const hasFolders = parsed.items.some((item) => item.folder);
    setFolderMode(hasFolders ? "keep" : "single");
    setSingleFolder(defaultFolderName(parsed.source));
  }

  /** Re-read the file already in hand as a format the user named. */
  async function reparse(source: SourceId) {
    if (
      stage.step !== "preview" &&
      stage.step !== "failed" &&
      stage.step !== "locked"
    ) {
      return;
    }
    setError(null);
    try {
      show(
        stage.fileName,
        stage.file,
        await parseImportAsync({ ...stage.file, password }, source),
      );
    } catch (caught) {
      setError(messageFrom(caught));
    }
  }

  async function confirm() {
    if (!plan) return;
    setBusy(true);
    setError(null);
    try {
      const added = await store.applyImport(plan);
      setStage({ step: "done", added, skipped: plan.duplicates.length });
    } catch (caught) {
      setError(messageFrom(caught));
    } finally {
      setBusy(false);
    }
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    const file = event.dataTransfer.files[0];
    if (file) void readFile(file);
  }

  return (
    <section className="panel" id="import" ref={panelRef}>
      <div className="panel__head">
        <div>
          <h2>Import</h2>
          <p>
            Prefer a <code>.env</code> file — each key becomes an agent secret.
            Password-manager exports still work. The file is read in this tab
            and never uploaded; review before anything is written.
          </p>
        </div>
      </div>

      <div className="panel__body">
        {stage.step === "idle" ? (
          <>
            {/* The label inside is the keyboard and screen-reader path; the
                drop target is an enhancement over it, not a replacement. */}
            <div
              className={`imp__drop ${dragging ? "is-over" : ""}`}
              onDragOver={(event) => {
                event.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={onDrop}
            >
              <IconUpload size={22} />
              <p>
                <label htmlFor="manager-import" className="imp__pick">
                  Choose an export file
                </label>{" "}
                or drop one here.
              </p>
              <input
                ref={fileRef}
                id="manager-import"
                type="file"
                accept=".env,.csv,.json,.1pux,.zip,.kdbx,text/plain,text/csv,application/json"
                className="visually-hidden"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void readFile(file);
                }}
              />
            </div>

            <details className="imp__formats">
              <summary>What can be imported</summary>
              <ul>
                {LISTED.filter((a) => a.id !== "generic-csv").map((adapter) => (
                  <li key={adapter.id}>
                    <strong>{adapter.label}</strong>
                    <span>{adapter.hint}</span>
                  </li>
                ))}
              </ul>
              <p className="hint">
                Start with a <code>.env</code> (<code>KEY=value</code> lines).
                Any CSV with name, username, and password columns works too.
              </p>
            </details>
          </>
        ) : null}

        {stage.step === "reading" ? (
          <output className="imp__reading">Reading {stage.fileName}…</output>
        ) : null}

        {stage.step === "locked" ? (
          <form
            className="imp__preview"
            onSubmit={(event) => {
              event.preventDefault();
              void unlock();
            }}
          >
            <div className="imp__found">
              <div>
                <h3>{stage.fileName}</h3>
                <p className="hint">
                  {adapterFor(stage.source)?.label ?? stage.source}
                  {stage.note === "" ? "" : ` — ${stage.note}`}
                </p>
              </div>
            </div>
            <div className="field">
              <label htmlFor="imp-password">Master password</label>
              <input
                id="imp-password"
                type="password"
                autoComplete="off"
                // The one field on this page whose value is a secret; nothing
                // should be offering to remember it.
                data-1p-ignore="true"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </div>
            {error ? (
              <p className="note note--err" role="alert">
                <span>{error}</span>
              </p>
            ) : null}
            <div className="actions">
              <button
                type="submit"
                className="btn btn--primary"
                disabled={busy || password === ""}
                aria-busy={busy}
              >
                <IconLock size={16} />
                {busy ? "Opening…" : "Open database"}
              </button>
              <button type="button" className="btn btn--ghost" onClick={reset}>
                <IconX size={16} />
                Cancel
              </button>
            </div>
          </form>
        ) : null}

        {stage.step === "failed" ? (
          <div className="imp__preview">
            <div className="imp__found">
              <div>
                <h3>{stage.fileName}</h3>
                {error ? (
                  <p className="hint" role="alert">
                    {error}
                  </p>
                ) : null}
              </div>
              <div className="field">
                <label htmlFor="imp-format-force">Read it as</label>
                <select
                  id="imp-format-force"
                  defaultValue=""
                  onChange={(event) =>
                    void reparse(overlapCast(event.target.value))
                  }
                >
                  <option value="" disabled>
                    Choose a format…
                  </option>
                  {LISTED.map((adapter) => (
                    <option key={adapter.id} value={adapter.id}>
                      {adapter.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="actions">
              <button type="button" className="btn btn--ghost" onClick={reset}>
                <IconX size={16} />
                Choose a different file
              </button>
            </div>
          </div>
        ) : null}

        {stage.step === "preview" && result && summary && plan ? (
          <div className="imp__preview">
            <div className="imp__found">
              <div>
                <h3>{stage.fileName}</h3>
                <p className="hint">
                  Recognised as{" "}
                  {adapterFor(result.source)?.label ?? result.source}.
                </p>
              </div>
              <div className="field">
                <label htmlFor="imp-format">Read it as</label>
                <select
                  id="imp-format"
                  value={result.source}
                  onChange={(event) =>
                    void reparse(overlapCast(event.target.value))
                  }
                >
                  {LISTED.map((adapter) => (
                    <option key={adapter.id} value={adapter.id}>
                      {adapter.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <ul className="imp__counts">
              <Count
                n={summary.logins}
                one="login"
                many="logins"
                kind="login"
              />
              <Count
                n={summary.passkeys}
                one="passkey"
                many="passkeys"
                kind="passkey"
              />
              <Count n={summary.cards} one="card" many="cards" kind="card" />
              <Count n={summary.notes} one="note" many="notes" kind="note" />
              <Count
                n={summary.secrets}
                one="secret"
                many="secrets"
                kind="secret"
              />
              {summary.withTotp > 0 ? (
                <li className="imp__count">
                  <strong>{summary.withTotp}</strong>
                  <span>with a 2FA code</span>
                </li>
              ) : null}
              {summary.folders.length > 0 ? (
                <li className="imp__count">
                  <strong>{summary.folders.length}</strong>
                  <span>
                    {summary.folders.length === 1 ? "folder" : "folders"}
                  </span>
                </li>
              ) : null}
            </ul>

            {result.warnings.map((warning) => (
              <p className="note note--warn" key={warning}>
                <IconInfo size={16} />
                <span>{warning}</span>
              </p>
            ))}

            {summary.withoutPassword > 0 ? (
              <p className="note note--warn">
                <IconAlert size={16} />
                <span>
                  {summary.withoutPassword}{" "}
                  {summary.withoutPassword === 1 ? "login has" : "logins have"}{" "}
                  no password. They are imported so the username and site are
                  not lost.
                </span>
              </p>
            ) : null}

            {result.skipped.length > 0 ? (
              <details className="imp__skipped">
                <summary>
                  {result.skipped.length}{" "}
                  {result.skipped.length === 1 ? "record" : "records"} the file
                  asked to leave out
                </summary>
                <ul>
                  {result.skipped.map((record) => (
                    <li key={`${record.name}-${record.reason}`}>
                      <strong>{record.name}</strong>
                      <span>{record.reason}</span>
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}

            <fieldset className="imp__options">
              <legend>Where these should land</legend>
              {/* An export with no folders of its own has nothing to recreate,
                  so offering it would be an option that does nothing. */}
              {summary.folders.length > 0 ? (
                <label className="check">
                  <input
                    type="radio"
                    name="imp-folders"
                    checked={folderMode === "keep"}
                    onChange={() => setFolderMode("keep")}
                  />
                  <span>
                    Recreate the {summary.folders.length}{" "}
                    {summary.folders.length === 1 ? "folder" : "folders"} from
                    the export
                    <em className="imp__folderlist">
                      {summary.folders.slice(0, 6).join(", ")}
                      {summary.folders.length > 6
                        ? `, and ${summary.folders.length - 6} more`
                        : ""}
                    </em>
                  </span>
                </label>
              ) : null}
              <label className="check">
                <input
                  type="radio"
                  name="imp-folders"
                  checked={folderMode === "single"}
                  onChange={() => setFolderMode("single")}
                />
                <span>Put everything in one new folder</span>
              </label>
              {folderMode === "single" ? (
                <input
                  className="imp__foldername"
                  aria-label="Name of the folder to import into"
                  placeholder={defaultFolderName(result.source)}
                  value={singleFolder}
                  onChange={(event) => setSingleFolder(event.target.value)}
                />
              ) : null}
              <label className="check">
                <input
                  type="radio"
                  name="imp-folders"
                  checked={folderMode === "none"}
                  onChange={() => setFolderMode("none")}
                />
                <span>
                  {summary.folders.length > 0
                    ? "No folders"
                    : "Leave them unfiled"}
                </span>
              </label>
            </fieldset>

            <label className="check">
              <input
                type="checkbox"
                checked={options.skipDuplicates}
                onChange={(event) =>
                  setOptions({
                    ...options,
                    skipDuplicates: event.target.checked,
                  })
                }
              />
              <span>
                Skip items this vault already has
                {plan.duplicates.length > 0 ? (
                  <em className="imp__folderlist">
                    {plan.duplicates.length}{" "}
                    {plan.duplicates.length === 1 ? "match" : "matches"} by name
                    and username
                  </em>
                ) : null}
              </span>
            </label>

            {plan.items.length === 0 && plan.duplicates.length > 0 ? (
              <p className="note note--ok">
                <IconCheck size={16} />
                <span>
                  Every item in this file is already in the vault. Untick the
                  box above to bring in copies anyway.
                </span>
              </p>
            ) : (
              <ItemTable items={plan.items} folders={folderNames} />
            )}

            <p className="note note--warn">
              <IconAlert size={16} />
              <span>
                Delete the export file once this is done. It holds every
                password in plain text, and it is still sitting in your
                downloads.
              </span>
            </p>

            {error ? (
              <p className="note note--err" role="alert">
                <span>{error}</span>
              </p>
            ) : null}

            <div className="actions">
              <button
                type="button"
                className="btn btn--primary"
                disabled={busy || plan.items.length === 0}
                aria-busy={busy}
                onClick={() => void confirm()}
              >
                {busy
                  ? "Importing…"
                  : plan.items.length === 0
                    ? "Nothing to import"
                    : `Import ${plan.items.length} ${plan.items.length === 1 ? "item" : "items"}`}
              </button>
              <button type="button" className="btn btn--ghost" onClick={reset}>
                <IconX size={16} />
                Cancel
              </button>
            </div>
          </div>
        ) : null}

        {stage.step === "done" ? (
          <>
            <p className="note note--ok">
              <IconCheck size={16} />
              <span>
                Imported {stage.added} {stage.added === 1 ? "item" : "items"}
                {stage.skipped > 0
                  ? `, and left ${stage.skipped} already in the vault alone`
                  : ""}
                . Everything is sealed under your master password.
              </span>
            </p>
            <div className="actions">
              <button type="button" className="btn" onClick={reset}>
                Import another file
              </button>
            </div>
          </>
        ) : null}

        {error && stage.step === "idle" ? (
          <p className="note note--err" role="alert">
            <span>{error}</span>
          </p>
        ) : null}
      </div>
    </section>
  );
}

function Count({
  n,
  one,
  many,
  kind,
}: {
  n: number;
  one: string;
  many: string;
  kind: keyof typeof KIND_ICON;
}) {
  if (n === 0) return null;
  const Icon = KIND_ICON[kind];
  return (
    <li className="imp__count">
      <Icon size={16} />
      <strong>{n}</strong>
      <span>{n === 1 ? one : many}</span>
    </li>
  );
}

function ItemTable({
  items,
  folders,
}: {
  items: VaultItem[];
  folders: Map<string, string>;
}) {
  if (items.length === 0) return null;
  const shown = items.slice(0, PREVIEW_LIMIT);

  return (
    <div
      className="imp__table"
      // biome-ignore lint/a11y/noNoninteractiveTabindex: the preview scrolls, and a scroll container keyboard focus cannot reach is unreadable.
      tabIndex={0}
      aria-label="Items to be imported"
    >
      <table>
        <thead>
          <tr>
            <th scope="col">Name</th>
            <th scope="col">Detail</th>
            <th scope="col">Folder</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((item) => (
            <tr key={item.id}>
              <th scope="row">{item.name}</th>
              <td>
                {item.kind === "login"
                  ? item.username || "—"
                  : item.kind === "secret"
                    ? "agent secret"
                    : "—"}
              </td>
              <td>
                {item.folderId ? (folders.get(item.folderId) ?? "—") : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {items.length > shown.length ? (
        <p className="hint">
          Showing the first {shown.length} of {items.length}.
        </p>
      ) : null}
    </div>
  );
}

function defaultFolderName(source: SourceId): string {
  return `Imported from ${adapterFor(source)?.shortName ?? "another manager"}`;
}
