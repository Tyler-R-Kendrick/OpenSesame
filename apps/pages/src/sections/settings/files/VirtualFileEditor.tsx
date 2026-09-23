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
import {
  IconCheck,
  IconLock,
  IconTrash,
  IconX,
} from "../../../components/Icons.js";
import { StatusMark } from "../../../components/StatusMark.js";

type Outcome = { tone: "ok" | "err"; text: string } | null;

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
        className="icon-btn icon-btn--sm icon-btn--danger is-armed"
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

/** The open file's text, and the stored copy it was read from. */
function useFileText(
  file: VirtualFile,
  files: VirtualFileProvider,
  initial: string | undefined,
) {
  const [text, setText] = useState(initial ?? "");
  const [outcome, setOutcome] = useState<Outcome>(null);
  useEffect(() => {
    setOutcome(null);
    if (initial !== undefined) {
      setText(initial);
      return;
    }
    let live = true;
    void files.read(file.path).then((stored) => {
      if (live) setText(stored);
    });
    return () => {
      live = false;
    };
  }, [file.path, files, initial]);
  return { text, setText, outcome, setOutcome };
}

function HeadKeys({
  file,
  outcome,
  canSave,
  onSave,
  onRemove,
}: {
  file: VirtualFile;
  outcome: Outcome;
  canSave: boolean;
  onSave: () => void;
  onRemove: () => void;
}) {
  return (
    <span className="vfile__keys">
      {outcome ? <StatusMark tone={outcome.tone} label={outcome.text} /> : null}
      {file.readOnly ? (
        <span
          className="vfile__lock"
          role="img"
          aria-label="Part of the build; read-only"
          title="Part of the build; read-only"
        >
          <IconLock size={14} />
        </span>
      ) : (
        <button
          type="button"
          className="icon-btn icon-btn--sm"
          disabled={!canSave}
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
  const { text, setText, outcome, setOutcome } = useFileText(
    file,
    files,
    initial,
  );
  const check = file.readOnly
    ? { ok: true as const }
    : files.check(file.path, text);

  const save = async () => {
    if (file.readOnly) return;
    const written = await files.write(file.path, text);
    if (!written.ok) {
      setOutcome({ tone: "err", text: written.message });
      return;
    }
    setOutcome({ tone: "ok", text: `Saved ${written.path}.` });
    if (written.path !== file.path) onMoved(written.path);
  };

  const remove = async () => {
    const removed = await files.remove(file.path);
    if (removed.ok) onMoved(null);
    else setOutcome({ tone: "err", text: removed.message });
  };

  return (
    <section className="panel set-raw vfile" aria-label={file.path}>
      <div className="panel__head">
        <p className="set-raw__path">{file.path}</p>
        <HeadKeys
          file={file}
          outcome={outcome}
          canSave={check.ok}
          onSave={() => void save()}
          onRemove={() => void remove()}
        />
      </div>
      <div className="panel__body">
        <textarea
          className="vfile__text"
          aria-label={file.path}
          spellCheck={false}
          autoComplete="off"
          wrap="off"
          readOnly={file.readOnly}
          rows={Math.min(Math.max(text.split("\n").length + 1, 8), 32)}
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            setOutcome(null);
          }}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "s") {
              event.preventDefault();
              void save();
            }
          }}
        />
        {check.ok ? null : (
          <p className="vfile__refusal">
            <StatusMark tone="err" label="Refused" />
            <span>{check.message}</span>
          </p>
        )}
        <output className="visually-hidden" aria-live="polite">
          {outcome?.text ?? ""}
        </output>
      </div>
    </section>
  );
}
