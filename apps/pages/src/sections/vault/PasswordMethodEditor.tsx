import { setStatusNotice } from "@opensesame/app-core/lib/notices.js";
import {
  GENERATORS,
  rotateSphinx,
} from "@opensesame/app-core/lib/vault/generators/index.js";
import {
  type AccountItem,
  type PasswordGenerator,
  type PasswordGeneratorId,
  type PasswordMethod,
  WrongPepperError,
} from "@opensesame/vault-core";
import { useRef, useState } from "react";
import { GeneratorOptions } from "../../components/GeneratorOptions.js";
import { IconKey } from "../../components/IconKey.js";
import { IconEye, IconEyeOff, IconRefresh } from "../../components/Icons.js";
import {
  type PepperAskFn,
  isPepperCancelled,
} from "../../components/PepperPrompt.js";
import { StatusMark } from "../../components/StatusMark.js";
import {
  type MethodEdit,
  type PlainMap,
  holdValue,
  pepperOff,
  pepperOn,
  regenerate,
  switchGenerator,
} from "./account-secrets.js";

function generatorId(value: string): PasswordGeneratorId | undefined {
  return GENERATORS.find((entry) => entry.id === value)?.id;
}

/**
 * One password method: its generator, that generator's options, the password
 * (typed, generated, or computed on use) and *Include pepper* (ADR 0166 §6).
 * Nothing is drawn for a precondition that is unmet: Sphinx has no password
 * field and no pepper flag; a sealed password has no eye until it is new.
 */
export function PasswordMethodEditor({
  account,
  method,
  plain,
  ask,
  liveRoll,
  onEdit,
}: {
  account: AccountItem;
  method: PasswordMethod;
  plain: PlainMap;
  ask: PepperAskFn;
  /** A draft that has never been saved makes a new password as its options change. */
  liveRoll: boolean;
  onEdit: (edit: MethodEdit) => void;
}) {
  const [reveal, setReveal] = useState(false);
  const [wrong, setWrong] = useState(false);
  const busy = useRef(false);
  const { generator } = method;
  const descriptor = GENERATORS.find((entry) => entry.id === generator.id);
  const sphinx = generator.id === "sphinx";
  const entry = plain[method.id];
  const value = method.pepper ? (entry?.value ?? "") : method.secret;
  const sealedUnknown = method.pepper && entry === undefined;

  const retune = (next: PasswordGenerator) => {
    onEdit({ method: { ...method, generator: next }, plain: entry ?? null });
  };
  // On a new account a stored generator makes a new password as its options
  // change, so the field shows what these options produce. On a saved one the
  // password stays until the person asks for another.
  const reshape = (next: PasswordGenerator) => {
    const tuned = { ...method, generator: next };
    const made =
      liveRoll && (next.id === "rules" || next.id === "passphrase")
        ? regenerate(tuned)
        : null;
    if (made) onEdit(made);
    else retune(next);
  };

  const guarded = async (task: () => Promise<MethodEdit>) => {
    if (busy.current) return;
    busy.current = true;
    try {
      onEdit(await task());
      setWrong(false);
    } catch (caught) {
      if (isPepperCancelled(caught)) return;
      if (caught instanceof WrongPepperError) {
        setWrong(true);
        setStatusNotice({
          id: `pepper:${method.id}`,
          tone: "err",
          title: "Pepper",
          body: "That pepper did not open this password.",
        });
        return;
      }
      throw caught;
    } finally {
      busy.current = false;
    }
  };

  return (
    <>
      <div className="field">
        <label htmlFor={`${method.id}-generator`}>Generator</label>
        <div className="editor__inline">
          <select
            id={`${method.id}-generator`}
            aria-label="Password generator"
            value={generator.id}
            onChange={(event) => {
              const id = generatorId(event.target.value);
              if (id) onEdit(switchGenerator(account, method, id, plain));
            }}
          >
            {GENERATORS.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
          {wrong ? <StatusMark tone="err" label="Wrong pepper" /> : null}
        </div>
      </div>
      <GeneratorOptions generator={generator} onChange={reshape} />
      {sphinx ? (
        <div className="field">
          <span className="label">Password</span>
          <div className="editor__inline">
            <StatusMark tone="idle" label="Computed on use, never stored" />
            <IconKey
              label="Rotate password"
              onClick={() => {
                if (generator.id === "sphinx") retune(rotateSphinx(generator));
              }}
            >
              <IconRefresh size={17} />
            </IconKey>
          </div>
        </div>
      ) : (
        <div className="field">
          <label htmlFor={`${method.id}-password`}>Password</label>
          <div className="editor__inline editor__inline--adorned">
            <input
              id={`${method.id}-password`}
              type={reveal && !sealedUnknown ? "text" : "password"}
              autoComplete="new-password"
              spellCheck={false}
              placeholder={
                sealedUnknown && method.sealed ? "••••••••" : undefined
              }
              value={value}
              onChange={(event) => {
                const typed = event.target.value;
                const manual =
                  generator.id === "manual"
                    ? method
                    : { ...method, generator: { id: "manual" } as const };
                onEdit(holdValue(manual, typed));
              }}
            />
            {sealedUnknown ? null : (
              <IconKey
                label={reveal ? "Hide password" : "Show password"}
                aria-pressed={reveal}
                onClick={() => setReveal((on) => !on)}
              >
                {reveal ? <IconEyeOff size={17} /> : <IconEye size={17} />}
              </IconKey>
            )}
            {generator.id === "rules" || generator.id === "passphrase" ? (
              <IconKey
                label="Generate another password"
                onClick={() => {
                  const made = regenerate(method);
                  if (made) {
                    onEdit(made);
                    setReveal(true);
                  }
                }}
              >
                <IconRefresh size={17} />
              </IconKey>
            ) : null}
          </div>
        </div>
      )}
      {descriptor?.offersPepperFlag ? (
        <div className="field">
          <label className="check">
            <input
              type="checkbox"
              checked={method.pepper}
              onChange={(event) => {
                const on = event.target.checked;
                void guarded(() =>
                  on
                    ? pepperOn(account, method, plain, ask)
                    : pepperOff(account, method, plain, ask),
                );
              }}
            />
            <span>Include pepper</span>
          </label>
        </div>
      ) : null}
    </>
  );
}
