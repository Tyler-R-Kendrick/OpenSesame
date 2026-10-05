import {
  GENERATORS,
  rotateSphinx,
} from "@opensesame/app-core/lib/vault/generators/index.js";
import type {
  AccountItem,
  PasswordGenerator,
  PasswordGeneratorId,
  PasswordMethod,
} from "@opensesame/vault-core";
import { useState } from "react";
import { GeneratorOptions } from "../../components/GeneratorOptions.js";
import { IconKey } from "../../components/IconKey.js";
import { IconRefresh } from "../../components/Icons.js";
import type { PepperAskFn } from "../../components/PepperPrompt.js";
import { StatusMark } from "../../components/StatusMark.js";
import { PasswordFieldRow } from "./PasswordFieldRow.js";
import { PepperCheck } from "./PepperCheck.js";
import {
  type MethodEdit,
  type PlainMap,
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
  const [wrong, setWrong] = useState(false);
  const { generator } = method;
  const entry = plain[method.id];
  const descriptor = GENERATORS.find((option) => option.id === generator.id);

  const retune = (next: PasswordGenerator) =>
    onEdit({ method: { ...method, generator: next }, plain: entry ?? null });
  // On a new account a stored generator makes a new password as its options
  // change, so the field shows what these options produce. On a saved one the
  // password stays until the person asks for another.
  const retuneOptions = (next: PasswordGenerator) => {
    const made = liveRoll ? regenerate({ ...method, generator: next }) : null;
    if (made) onEdit(made);
    else retune(next);
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
      <GeneratorOptions generator={generator} onChange={retuneOptions} />
      {generator.id === "sphinx" ? (
        <div className="field">
          <span className="label">Password</span>
          <div className="editor__inline">
            <StatusMark tone="idle" label="Computed on use, never stored" />
            <IconKey
              label="Rotate password"
              onClick={() => retune(rotateSphinx(generator))}
            >
              <IconRefresh size={17} />
            </IconKey>
          </div>
        </div>
      ) : (
        <PasswordFieldRow method={method} entry={entry} onEdit={onEdit} />
      )}
      {descriptor?.offersPepperFlag ? (
        <PepperCheck
          account={account}
          method={method}
          plain={plain}
          ask={ask}
          onEdit={onEdit}
          onWrong={setWrong}
        />
      ) : null}
    </>
  );
}
