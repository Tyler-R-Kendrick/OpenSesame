/**
 * Writes `spec/conformance/produce-vectors.json` from `produce-vectors.fixture.ts`
 * (ADR 0139): `EMIT_PRODUCE_VECTORS=1 pnpm --filter @opensesame/vault-core test
 * -- produce-vectors.emit`. Skipped otherwise. The vectors are a frozen contract
 * between this facade and `crates/sealed-store`; replace them only deliberately.
 */
import { writeFileSync } from "node:fs";
import { describe, it } from "vitest";
import { deriveCharacters } from "./derive.js";
import { splitAtPepper } from "./pepper-position.js";
import {
  DERIVED_CASES,
  POSITION_CASES,
  POSITION_PASSWORD,
} from "./produce-vectors.fixture.js";

describe.skipIf(process.env.EMIT_PRODUCE_VECTORS !== "1")(
  "emit the produce vectors",
  () => {
    it("writes spec/conformance/produce-vectors.json", () => {
      const fixture = {
        about:
          "Golden vectors for producing a password (ADR 0174): the algorithmic generator and where a pepper goes. Read by packages/vault-core and crates/sealed-store. Synthetic data. Never regenerate to make a test pass.",
        derived: DERIVED_CASES.map((entry) => ({
          ...entry,
          password: deriveCharacters(entry.root, entry.counter, entry.rules),
        })),
        positions: {
          password: POSITION_PASSWORD,
          cases: POSITION_CASES.map((expression) => ({
            expression,
            ...splitAtPepper(POSITION_PASSWORD, expression),
          })),
        },
      };
      writeFileSync(
        new URL(
          "../../../spec/conformance/produce-vectors.json",
          import.meta.url,
        ),
        `${JSON.stringify(fixture, null, 2)}\n`,
      );
    });
  },
);
