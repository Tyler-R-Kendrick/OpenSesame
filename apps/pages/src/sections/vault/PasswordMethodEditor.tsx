import {
  GENERATORS,
  type OfferedGeneratorId,
  isLegacyMethod,
  offeredGenerators,
} from "@opensesame/app-core/lib/vault/generators/index.js";
import type {
  AccountItem,
  PasswordGenerator,
  PasswordMethod,
} from "@opensesame/vault-core";
import { GeneratorOptions } from "../../components/GeneratorOptions.js";
import { LegacyConvert } from "./LegacyConvert.js";
import { PasswordFieldRow } from "./PasswordFieldRow.js";
import { PepperCheck } from "./PepperCheck.js";
import { regenerate, switchGenerator } from "./account-secrets.js";

/** The generator a select value names, if it is one a person can choose. */
function generatorId(value: string): OfferedGeneratorId | undefined {
  const id = GENERATORS.find((entry) => entry.id === value)?.id;
  return id === "sphinx" ? undefined : id;
}

/**
 * One password method: its generator, that generator's options behind one line,
 * the password (typed, generated or computed) and *Include pepper* with where
 * it goes (ADR 0172 §6, ADR 0174). A password an older version made from a typed
 * pepper has none of that: it is converted once, then it is an ordinary one.
 */
export function PasswordMethodEditor({
  account,
  method,
  liveRoll,
  onEdit,
}: {
  account: AccountItem;
  method: PasswordMethod;
  /** A draft that has never been saved makes a new password as its options change. */
  liveRoll: boolean;
  onEdit: (next: PasswordMethod) => void;
}) {
  if (isLegacyMethod(method)) {
    return (
      <LegacyConvert account={account} method={method} onConvert={onEdit} />
    );
  }
  const { generator } = method;
  const options = offeredGenerators(generator.id);

  // On a new account a stored generator makes a new password as its options
  // change, so the field shows what these options produce. On a saved one the
  // password stays until the person asks for another.
  const retuneOptions = (next: PasswordGenerator) => {
    const moved: PasswordMethod = { ...method, generator: next };
    onEdit((liveRoll ? regenerate(moved) : null) ?? moved);
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
              if (id) onEdit(switchGenerator(method, id));
            }}
          >
            {options.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
      </div>
      <GeneratorOptions generator={generator} onChange={retuneOptions} />
      <PasswordFieldRow method={method} onEdit={onEdit} />
      <PepperCheck method={method} onEdit={onEdit} />
    </>
  );
}
