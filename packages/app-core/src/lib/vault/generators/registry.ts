/**
 * The generator registry (ADR 0172 §3, ADR 0173): one module per id behind one
 * descriptor row, so a later generator adds a module and a row, not a branch.
 */

import {
  DEFAULT_RULES,
  type PassphraseGenerator,
  type PasswordGenerator,
  type PasswordGeneratorId,
  type RulesGenerator,
} from "@opensesame/vault-core";
import {
  defaultPassphraseOptions,
  generatorEntropyBits as optionsEntropyBits,
} from "../password.js";
import { effectiveLength } from "./characters.js";
import { generatePassphraseFor } from "./passphrase.js";
import { generateRules } from "./rules.js";

/** The generators a person can choose. `sphinx` (ADR 0172) is read, never offered. */
export type OfferedGeneratorId = Exclude<PasswordGeneratorId, "sphinx">;

export type GeneratorDescriptor = {
  id: PasswordGeneratorId;
  label: string;
  /** produces a value that is then stored (sealed under pepper if set) */
  produces: "stored" | "derived" | "typed";
  /** the Include pepper control is drawn for this generator (false only for sphinx: its master input is implied) */
  offersPepperFlag: boolean;
};

export const GENERATORS: readonly GeneratorDescriptor[] = [
  {
    id: "derived",
    label: "Derived",
    produces: "derived",
    offersPepperFlag: true,
  },
  { id: "rules", label: "Rules", produces: "stored", offersPepperFlag: true },
  {
    id: "passphrase",
    label: "Passphrase",
    produces: "stored",
    offersPepperFlag: true,
  },
  { id: "manual", label: "Manual", produces: "typed", offersPepperFlag: true },
];

/** The row for a method that already uses the earlier Sphinx generator. */
const SPHINX_ROW: GeneratorDescriptor = {
  id: "sphinx",
  label: "Sphinx (earlier)",
  produces: "derived",
  offersPepperFlag: false,
};

/** The generators to choose from for a method now using `current`. */
export function offeredGenerators(
  current: PasswordGeneratorId,
): readonly GeneratorDescriptor[] {
  return current === "sphinx" ? [...GENERATORS, SPHINX_ROW] : GENERATORS;
}

export function defaultGenerator(id: OfferedGeneratorId): PasswordGenerator {
  switch (id) {
    case "derived":
      return { id, rules: { ...DEFAULT_RULES }, counter: 0 };
    case "rules":
      return { id, ...DEFAULT_RULES };
    case "passphrase": {
      const { mode: _mode, ...options } = defaultPassphraseOptions;
      return { id, ...options };
    }
    case "manual":
      return { id };
  }
}

export function generateStored(
  generator: RulesGenerator | PassphraseGenerator,
): string {
  return generator.id === "rules"
    ? generateRules(generator)
    : generatePassphraseFor(generator);
}

/**
 * Exact entropy of a generator's own configuration, in bits. For `derived` and
 * `sphinx` it is the entropy of the shape the output is encoded into. `null`
 * for `manual`.
 */
export function generatorEntropyBits(
  generator: PasswordGenerator,
): number | null {
  switch (generator.id) {
    case "manual":
      return null;
    case "passphrase": {
      const { id: _id, ...options } = generator;
      return optionsEntropyBits({ mode: "passphrase", ...options });
    }
    case "rules":
    case "derived":
    case "sphinx": {
      const rules = generator.id === "rules" ? generator : generator.rules;
      return optionsEntropyBits({
        mode: "characters",
        length: effectiveLength(rules),
        lower: rules.lower,
        upper: rules.upper,
        digits: rules.digits,
        symbols: rules.symbols,
        avoidAmbiguous: rules.avoidAmbiguous,
      });
    }
  }
}
