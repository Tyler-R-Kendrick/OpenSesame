import {
  type Strength,
  defaultPassphraseOptions,
  estimateStrength,
  generate,
} from "@opensesame/app-core/lib/vault/password.js";
import { type FormEvent, useState } from "react";
import { FieldShell } from "../components/FieldShell.js";
import {
  IconEye,
  IconEyeOff,
  IconLock,
  IconLogin,
  IconRefresh,
} from "../components/Icons.js";
import { StatusNote } from "../components/StatusNote.js";
import { useVault, useVaultStore } from "../lib/vault/hooks.js";
import { useGuideTarget } from "../tutorial/registry/react.jsx";

function StrengthReadout({
  next,
  nextStrength,
}: {
  next: string;
  nextStrength: Strength;
}) {
  return (
    <div className="str">
      <div className="str__bars" aria-hidden="true">
        {[0, 1, 2, 3, 4].map((slot) => (
          <span
            key={slot}
            className="str__bar"
            style={
              next && slot <= nextStrength.score
                ? { background: `var(--s-${nextStrength.score})` }
                : undefined
            }
          />
        ))}
      </div>
      <p className="str__read" id="next-master-strength">
        {next ? (
          <>
            <span
              className="str__label"
              style={{ color: `var(--s-${nextStrength.score})` }}
            >
              {nextStrength.label}
            </span>
            <span className="str__bits">{nextStrength.bits} bits</span>
          </>
        ) : (
          <span className="hint">At least 12 characters, Fair or better</span>
        )}
      </p>
    </div>
  );
}

function NextPasswordField({
  next,
  showNext,
  disabled,
  onChange,
  onToggleShow,
  onSuggest,
}: {
  next: string;
  showNext: boolean;
  disabled: boolean;
  onChange: (value: string) => void;
  onToggleShow: () => void;
  onSuggest: () => void;
}) {
  return (
    <FieldShell
      id="next-master"
      label="New password"
      type={showNext ? "text" : "password"}
      autoComplete="new-password"
      lead={<IconLogin size={17} />}
      mono={showNext}
      value={next}
      disabled={disabled}
      onValueChange={onChange}
      tail={
        <>
          <button
            type="button"
            className="icon-btn"
            aria-label="Suggest a strong password"
            title="Suggest a strong password"
            disabled={disabled}
            onClick={onSuggest}
          >
            <IconRefresh size={17} />
          </button>
          <button
            type="button"
            className="icon-btn"
            aria-label={showNext ? "Hide password" : "Show password"}
            aria-pressed={showNext}
            onClick={onToggleShow}
          >
            {showNext ? <IconEyeOff size={17} /> : <IconEye size={17} />}
          </button>
        </>
      }
    />
  );
}

export function SettingsMasterPasswordPanel() {
  const { header } = useVault();
  const store = useVaultStore();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [showNext, setShowNext] = useState(false);
  const [rekey, setRekey] = useState<{
    tone: "ok" | "err";
    text: string;
  } | null>(null);
  const [rekeying, setRekeying] = useState(false);
  const rekeyRef = useGuideTarget<HTMLButtonElement>(
    "settings.master-password",
  );
  const nextStrength = estimateStrength(next);
  const nextTooWeak = next.length < 12 || nextStrength.score < 2;
  const hasWrap = Boolean(header?.wrap);

  async function changeMaster(event: FormEvent) {
    event.preventDefault();
    setRekey(null);
    setRekeying(true);
    try {
      await store.changeMasterPassword(current, next);
      setRekey({
        tone: "ok",
        text: "Master password changed. The vault key itself is unchanged, so your items were not re-encrypted.",
      });
      setCurrent("");
      setNext("");
      setShowNext(false);
    } catch (caught) {
      setRekey({
        tone: "err",
        text: caught instanceof Error ? caught.message : "Could not change it.",
      });
    } finally {
      setRekeying(false);
    }
  }

  return (
    <section className="panel">
      <div className="panel__head">
        <div>
          <h2>Master password</h2>
        </div>
      </div>
      <form
        className="panel__body"
        onSubmit={(event) => void changeMaster(event)}
      >
        {!hasWrap || !header?.kdf ? (
          <p className="hint">
            This vault has no master-password unlock. Enroll one under Unlock
            methods, or change unlock methods there.
          </p>
        ) : null}
        <FieldShell
          id="current-master"
          label="Current"
          type="password"
          autoComplete="current-password"
          lead={<IconLock size={17} />}
          value={current}
          disabled={!hasWrap}
          onValueChange={setCurrent}
        />
        <NextPasswordField
          next={next}
          showNext={showNext}
          disabled={!hasWrap}
          onChange={setNext}
          onToggleShow={() => setShowNext((value) => !value)}
          onSuggest={() => {
            setNext(generate(defaultPassphraseOptions));
            setShowNext(true);
          }}
        />
        <div className="keyed-row keyed-row--field">
          <StrengthReadout next={next} nextStrength={nextStrength} />
          <button
            ref={rekeyRef}
            type="submit"
            className="icon-btn"
            disabled={rekeying || !hasWrap || !current || nextTooWeak}
            aria-busy={rekeying}
            aria-label="Change master password"
            title="Change master password"
          >
            <IconLock size={16} />
          </button>
        </div>
        <StatusNote message={rekey} />
      </form>
    </section>
  );
}
