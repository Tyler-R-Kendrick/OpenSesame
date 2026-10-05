/** The `passphrase` generator: random words from the bundled list (ADR 0168 §3). */

import type { PassphraseGenerator } from "@opensesame/vault-core";
import { generatePassphrase } from "../password.js";

export function generatePassphraseFor(generator: PassphraseGenerator): string {
  return generatePassphrase({
    mode: "passphrase",
    words: generator.words,
    separator: generator.separator,
    capitalize: generator.capitalize,
    includeNumber: generator.includeNumber,
  });
}
