/**
 * The generator registry (ADR 0168 §3): one module per id behind one
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
import { mintOprfKey } from "./sphinx.js";

export type GeneratorDescriptor = {
  id: PasswordGeneratorId;
  label: string;
  /** produces a value that is then stored (sealed under pepper if set) */
  produces: "stored" | "derived" | "typed";
  /** the Include pepper control is drawn for this generator (false for sphinx: pepper is implied) */
  offersPepperFlag: boolean;
};

export const GENERATORS: readonly GeneratorDescriptor[] = [
  { id: "rules", label: "Rules", produces: "stored", offersPepperFlag: true },
  {
    id: "passphrase",
    label: "Passphrase",
    produces: "stored",
    offersPepperFlag: true,
  },
  {
    id: "sphinx",
    label: "Sphinx",
    produces: "derived",
    offersPepperFlag: false,
  },
  { id: "manual", label: "Manual", produces: "typed", offersPepperFlag: true },
];

export function defaultGenerator(
  id: PasswordGeneratorId,
  context: { realm: string },
): PasswordGenerator {
  switch (id) {
    case "rules":
      return { id, ...DEFAULT_RULES };
    case "passphrase": {
      const { mode: _mode, ...options } = defaultPassphraseOptions;
      return { id, ...options };
    }
    case "sphinx":
      return {
        id,
        rules: { ...DEFAULT_RULES },
        realm: context.realm,
        counter: 0,
        oprfKeyB64: mintOprfKey(),
      };
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
 * Exact entropy of a generator's own configuration, in bits. For `sphinx` it is
 * the entropy of the shape the output is encoded into. `null` for `manual`.
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
