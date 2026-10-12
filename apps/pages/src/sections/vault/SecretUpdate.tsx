import { generate } from "@opensesame/app-core/lib/vault/password.js";
import { type ReactNode, useState } from "react";
import { FailureNotice } from "../../components/FailureNotice.js";
import { IconKey } from "../../components/IconKey.js";
import {
  IconCheck,
  IconRefresh,
  IconSwap,
  IconX,
} from "../../components/Icons.js";
import { StatusMark } from "../../components/StatusMark.js";
import { useGuideTarget } from "../../tutorial/registry/react.jsx";

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

/** Run one operation at a time, holding its failure as a sentence. */
function useAttempt() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function attempt(task: () => Promise<void>, fallback: string) {
    setError(null);
    setBusy(true);
    try {
      await task();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : fallback);
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, setError, attempt };
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

export function UpdateSecretPanel({
  itemId,
  label,
  onUpdate,
  leading,
  compare,
  guideCompare = false,
}: UpdateSecretPanelProps) {
  const [open, setOpen] = useState(false);
  const [verdict, setVerdict] = useState<boolean | null>(null);
  const [mode, setMode] = useState<"generate" | "provide">("generate");
  const [value, setValue] = useState("");
  const { busy, error, setError, attempt } = useAttempt();

  const apply = () =>
    attempt(async () => {
      const next = mode === "generate" ? generatedSecret() : value;
      if (!next) throw new Error("Enter a new value.");
      await onUpdate(next);
      setOpen(false);
      setValue("");
      setVerdict(null);
    }, "Update failed.");

  const check = () =>
    attempt(async () => {
      try {
        setVerdict((await compare?.(value)) ?? null);
      } catch (caught) {
        setVerdict(null);
        throw caught;
      }
    }, "Compare failed.");

  const failure = (
    <FailureNotice
      id={`vault:secret-update:${itemId}:${label}`}
      title="Password update"
      message={error}
    />
  );
  const trigger = (
    <IconKey label={`Update ${label}`} onClick={() => setOpen(true)}>
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
  ) : open ? null : (
    trigger
  );
  if (!open)
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
        mode={mode}
        value={value}
        busy={busy}
        onMode={setMode}
        onValue={(next) => {
          setValue(next);
          setVerdict(null);
        }}
        onApply={() => void apply()}
        verdict={verdict}
        onCompare={compare ? () => void check() : undefined}
        compareGuide={guideCompare}
        onCancel={() => {
          setOpen(false);
          setError(null);
          setVerdict(null);
        }}
      />
    </>
  );
}
