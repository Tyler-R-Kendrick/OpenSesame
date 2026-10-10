/**
 * One virtual file, open. The text is the file as stored; saving writes it
 * through its provider, which is the only place a write is judged — the
 * same parser and the same registry rules the Form's keys go through. A
 * built-in file is shown read-only. Removing a file is armed in place.
 */

import type {
  VirtualFile,
  VirtualFileProvider,
} from "@opensesame/app-core/sections/settings/virtual-files.js";
import { useEffect, useState } from "react";
import { FailureNotice } from "../../../components/FailureNotice.js";
import {
  IconCheck,
  IconLock,
  IconTrash,
  IconX,
} from "../../../components/Icons.js";
import { StatusMark } from "../../../components/StatusMark.js";
import { PaintedText } from "./PaintedText.js";

type Outcome = { tone: "ok" | "warn" | "err"; text: string } | null;

function RemoveKeys({
  path,
  onRemove,
}: {
  path: string;
  onRemove: () => void;
}) {
  const [armed, setArmed] = useState(false);
  if (!armed)
    return (
      <button
        type="button"
        className="icon-btn icon-btn--sm"
        aria-label={`Remove ${path}`}
        title="Remove this file"
        onClick={() => setArmed(true)}
      >
        <IconTrash size={16} />
      </button>
    );
  return (
    <>
      <button
        type="button"
        className="icon-btn icon-btn--sm is-armed"
        aria-label={`Remove ${path}; items of this type keep their values`}
        title="Remove; items keep their values"
        onClick={onRemove}
      >
        <IconTrash size={16} />
      </button>
      <button
        type="button"
        className="icon-btn icon-btn--sm"
        aria-label={`Keep ${path}`}
        title="Keep it"
        onClick={() => setArmed(false)}
      >
        <IconX size={16} />
      </button>
    </>
  );
}

/**
 * The open file's text, and the stored copy it was read from. Until the
 * stored text has arrived the file is not `loaded`: what was typed before it
 * would be lost under it, or run into it, so nothing is typed or saved yet.
 */
function useFileText(
  file: VirtualFile,
  files: VirtualFileProvider,
  initial: string | undefined,
) {
  const [text, setText] = useState(initial ?? "");
  const [loaded, setLoaded] = useState(initial !== undefined);
  const [outcome, setOutcome] = useState<Outcome>(null);
  useEffect(() => {
    setOutcome(null);
    if (initial !== undefined) {
      setText(initial);
      setLoaded(true);
      return;
    }
    setLoaded(false);
    let live = true;
    void files.read(file.path).then((stored) => {
      if (!live) return;
      setText(stored);
      setLoaded(true);
    });
    return () => {
      live = false;
    };
  }, [file.path, files, initial]);
  return { text, setText, loaded, outcome, setOutcome };
}

/** Saving and removing the open file, each told back as an outcome. */
function useFileWrites(
  file: VirtualFile,
  files: VirtualFileProvider,
  { text, loaded, setText, setOutcome }: ReturnType<typeof useFileText>,
  onMoved: (path: string | null) => void,
) {
  const save = async () => {
    if (file.readOnly || !loaded) return;
    const written = await files.write(file.path, text);
    if (!written.ok) {
      setOutcome({ tone: "err", text: written.message });
      return;
    }
    setOutcome({
      tone: written.tone ?? "ok",
      text: written.message ?? `Saved ${written.path}.`,
    });
    if (written.text !== undefined) setText(written.text);
    if (written.path !== file.path) onMoved(written.path);
  };
  const remove = async () => {
    const removed = await files.remove(file.path);
    if (removed.ok) onMoved(null);
    else setOutcome({ tone: "err", text: removed.message });
  };
  return { save, remove };
}

function HeadKeys({
  file,
  outcome,
  refusal,
  loaded,
  onSave,
  onRemove,
}: {
  file: VirtualFile;
  outcome: Outcome;
  /** Why the text as it stands would be refused; a save is withheld. */
  refusal: string | null;
  /** The stored text has arrived; until then there is nothing to save. */
  loaded: boolean;
  onSave: () => void;
  onRemove: () => void;
}) {
  // The state is one glyph: a refusal of the text as it stands, else the
  // outcome of the last save (DESIGN.md § Status is a symbol).
  const mark =
    refusal !== null
      ? { tone: "err" as const, text: refusal }
      : (outcome ?? null);
  return (
    <span className="vfile__keys">
      {mark ? <StatusMark tone={mark.tone} label={mark.text} /> : null}
      {file.readOnly ? (
        <span
          className="vfile__lock"
          role="img"
          aria-label={file.readOnlyLabel ?? "Part of the build; read-only"}
          title={file.readOnlyLabel ?? "Part of the build; read-only"}
        >
          <IconLock size={14} />
        </span>
      ) : (
        <button
          type="button"
          className="icon-btn icon-btn--sm"
          disabled={refusal !== null || !loaded}
          aria-label={`Save ${file.path}`}
          title="Save"
          onClick={onSave}
        >
          <IconCheck size={14} />
        </button>
      )}
      {file.removable ? (
        <RemoveKeys path={file.path} onRemove={onRemove} />
      ) : null}
    </span>
  );
}

export function VirtualFileEditor({
  file,
  files,
  initial,
  onMoved,
}: {
  file: VirtualFile;
  files: VirtualFileProvider;
  /** A draft's starting text; otherwise the stored file is read. */
  initial?: string;
  /** Where the file lives after a save or a removal (null: it is gone). */
  onMoved: (path: string | null) => void;
}) {
  const state = useFileText(file, files, initial);
  const { text, setText, loaded, outcome, setOutcome } = state;
  const { save, remove } = useFileWrites(file, files, state, onMoved);
  // Nothing is judged before the stored text is there to judge.
  const check =
    file.readOnly || !loaded
      ? { ok: true as const }
      : files.check(file.path, text);

  const refusal = check.ok ? null : check.message;
  // A failed write goes to the tray; the mark in the head keeps the sentence
  // as its label. A draft that would be refused is live validation, a mark on
  // the field and nothing in the tray; a cautioned write ("kept for this
  // session only") is a disclosure and stays where it was.
  const failure = outcome?.tone === "err" ? outcome.text : null;

  return (
    <section className="panel set-raw vfile" aria-label={file.path}>
      <FailureNotice
        id={`settings-file:${file.path}`}
        title="Settings file"
        message={failure}
      />
      <div className="panel__head">
        <p className="set-raw__path">{file.path}</p>
        <HeadKeys
          file={file}
          outcome={outcome}
          refusal={refusal}
          loaded={loaded}
          onSave={() => void save()}
          onRemove={() => void remove()}
        />
      </div>
      <div className="panel__body">
        <PaintedText
          language={file.language}
          path={file.path}
          source={text}
          readOnly={file.readOnly}
          busy={!loaded}
          invalid={!check.ok}
          onChange={(next) => {
            setText(next);
            setOutcome(null);
          }}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "s") {
              event.preventDefault();
              void save();
            }
          }}
        />
        <output className="visually-hidden" aria-live="polite">
          {outcome?.tone === "err" ? "" : (outcome?.text ?? "")}
        </output>
        {/* A refused save or removal is an operation that failed, so it is
            trayed; the draft's live check above is only state and is not. */}
        <FailureNotice
          id={`settings-file:${file.path}`}
          title="Settings file"
          message={outcome?.tone === "err" ? outcome.text : null}
        />
      </div>
    </section>
  );
}
