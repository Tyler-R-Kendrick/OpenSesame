import { generate } from "@opensesame/app-core/lib/vault/password.js";
import { type ReactNode, useRef, useState } from "react";
import { IconKey } from "../../components/IconKey.js";
import {
  IconCheck,
  IconRefresh,
  IconSwap,
  IconX,
} from "../../components/Icons.js";
import { StatusMark } from "../../components/StatusMark.js";
import { useGuideTarget } from "../../tutorial/registry/react.jsx";
import {
  SecretUpdateFailure,
  useSecretAttempt,
  useSecretUpdateOwner,
} from "./secret-update-authority.js";

function generatedSecret(): string {
  return generate({
    mode: "characters",
    length: 32,
    lower: true,
    upper: true,
    digits: true,
    symbols: true,
    avoidAmbiguous: true,
  });
}

/** Compare the typed value with the saved one; the answer is a mark, never either value. */
function CompareKey({
  label,
  disabled,
  verdict,
  guide,
  onCompare,
}: {
  label: string;
  disabled: boolean;
  verdict: boolean | null;
  guide: boolean;
  onCompare: () => void;
}) {
  const guideRef = useGuideTarget<HTMLButtonElement>(
    "item.credentials.compare",
  );
  return (
    <>
      <IconKey
        keyRef={guide ? guideRef : undefined}
        label={`Compare with the saved ${label}`}
        disabled={disabled}
        onClick={onCompare}
      >
        <IconSwap size={17} />
      </IconKey>
      {verdict === null ? null : (
        <StatusMark
          tone={verdict ? "ok" : "warn"}
          label={
            verdict
              ? `Same as the saved ${label}`
              : `Differs from the saved ${label}`
          }
        />
      )}
    </>
  );
}

function UpdateEditor({
  label,
  mode,
  value,
  busy,
  onMode,
  onValue,
  onApply,
  onCancel,
  verdict,
  onCompare,
  compareGuide,
}: {
  label: string;
  mode: "generate" | "provide";
  value: string;
  busy: boolean;
  onMode: (mode: "generate" | "provide") => void;
  onValue: (value: string) => void;
  onApply: () => void;
  onCancel: () => void;
  /** What comparing the typed value with the saved one found, until it is typed over. */
  verdict: boolean | null;
  /** Present where the saved value can be compared with the typed one. */
  onCompare: (() => void) | undefined;
  compareGuide: boolean;
}) {
  return (
    <div className="detail__update">
      <fieldset className="sites-effect-toggle" aria-label="Update mode">
        <button
          type="button"
          className={
            mode === "generate" ? "sites-effect is-on is-allow" : "sites-effect"
          }
          aria-pressed={mode === "generate"}
          onClick={() => onMode("generate")}
        >
          Generate
        </button>
        <button
          type="button"
          className={
            mode === "provide" ? "sites-effect is-on is-allow" : "sites-effect"
          }
          aria-pressed={mode === "provide"}
          onClick={() => onMode("provide")}
        >
          Enter
        </button>
      </fieldset>
      {mode === "provide" ? (
        <input
          type="password"
          className="input"
          autoComplete="new-password"
          placeholder={`New ${label}`}
          aria-label={`New ${label}`}
          value={value}
          onChange={(event) => onValue(event.target.value)}
        />
      ) : null}
      <div className="actions">
        {onCompare && mode === "provide" ? (
          <CompareKey
            label={label}
            disabled={busy || value === ""}
            verdict={verdict}
            guide={compareGuide}
            onCompare={onCompare}
          />
        ) : null}
        <button
          type="button"
          className="icon-btn is-on"
          disabled={busy}
          aria-busy={busy}
          onClick={onApply}
          aria-label={busy ? "Saving…" : "Save new value"}
          title={busy ? "Saving…" : "Save new value"}
        >
          <IconCheck size={17} />
        </button>
        <IconKey label="Cancel" onClick={onCancel}>
          <IconX size={17} />
        </IconKey>
      </div>
    </div>
  );
}

/**
 * Replace a concealed value. `leading` sits in the same action cluster as
 * the update key; the editor opens beneath that row.
 */
type UpdateSecretPanelProps = {
  /** The item the secret belongs to: its notice is keyed by item, not field. */
  itemId: string;
  label: string;
  onUpdate: (next: string) => Promise<void>;
  leading?: ReactNode;
  /** Whether the typed value is the one saved, answered without showing either. */
  compare?: (candidate: string) => Promise<boolean>;
  /** This panel's Compare key is the one a tutorial points at. */
  guideCompare?: boolean;
};

/** The keyed editor retains its state and checked operations as one session. */
function useSecretEditor({
  onUpdate,
  compare,
  checkOwner,
}: Pick<UpdateSecretPanelProps, "onUpdate" | "compare"> & {
  checkOwner: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [verdict, setVerdict] = useState<boolean | null>(null);
  const [mode, setMode] = useState<"generate" | "provide">("generate");
  const [value, setValue] = useState("");
  const intent = useRef(0);
  const { busy, error, setError, attempt } = useSecretAttempt(
    checkOwner,
    () => intent.current,
  );

  const apply = () =>
    attempt(
      async (check) => {
        const started = intent.current;
        const next = mode === "generate" ? generatedSecret() : value;
        if (!next) throw new Error("Enter a new value.");
        check();
        await onUpdate(next);
        check();
        if (started !== intent.current) return;
        setOpen(false);
        setValue("");
        setVerdict(null);
      },
      mode === "provide" && value === ""
        ? "Enter a new value."
        : "Update failed.",
    );

  const compareValue = () =>
    attempt(async (check) => {
      const started = intent.current;
      check();
      const result = (await compare?.(value)) ?? null;
      check();
      if (started !== intent.current) return;
      setVerdict(result);
    }, "Compare failed.");

  return {
    open,
    verdict,
    mode,
    value,
    busy,
    error,
    apply,
    compareValue,
    openEditor: () => setOpen(true),
    changeMode: (next: "generate" | "provide") => {
      intent.current += 1;
      setMode(next);
      setVerdict(null);
    },
    changeValue: (next: string) => {
      intent.current += 1;
      setValue(next);
      setVerdict(null);
    },
    cancel: () => {
      intent.current += 1;
      setOpen(false);
      setError(null);
      setVerdict(null);
    },
  };
}

function AdmittedSecretPanel({
  itemId,
  label,
  onUpdate,
  leading,
  compare,
  guideCompare = false,
  checkOwner,
}: UpdateSecretPanelProps & { checkOwner: () => void }) {
  const editor = useSecretEditor({ onUpdate, compare, checkOwner });
  const noticeId = `vault:secret-update:${itemId}:${label}`;
  try {
    checkOwner();
  } catch {
    return null;
  }

  const failure = (
    <SecretUpdateFailure
      id={noticeId}
      checkOwner={checkOwner}
      message={editor.error}
    />
  );
  const trigger = (
    <IconKey label={`Update ${label}`} onClick={editor.openEditor}>
      <IconRefresh size={17} />
    </IconKey>
  );
  // With leading keys the update key joins them in one cluster; without, it is
  // drawn alone, and only while the editor is closed.
  const keys = leading ? (
    <div className="frow__actions">
      {leading}
      {trigger}
    </div>
  ) : editor.open ? null : (
    trigger
  );
  if (!editor.open)
    return (
      <>
        {failure}
        {keys}
      </>
    );
  return (
    <>
      {failure}
      {keys}
      <UpdateEditor
        label={label}
        mode={editor.mode}
        value={editor.value}
        busy={editor.busy}
        onMode={editor.changeMode}
        onValue={editor.changeValue}
        onApply={() => void editor.apply()}
        verdict={editor.verdict}
        onCompare={compare ? () => void editor.compareValue() : undefined}
        compareGuide={guideCompare}
        onCancel={editor.cancel}
      />
    </>
  );
}

/** Reauthentication constructs a new editor; previous values and consent cannot carry. */
export function UpdateSecretPanel(props: UpdateSecretPanelProps) {
  const owner = useSecretUpdateOwner(Boolean(props.compare));
  if (!owner) return null;
  return (
    <AdmittedSecretPanel
      key={`${owner.id}:${props.itemId}:${props.label}`}
      {...props}
      checkOwner={owner.check}
    />
  );
}
