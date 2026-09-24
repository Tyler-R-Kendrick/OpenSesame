import { describe, expect, it } from "vitest";
import policy from "../../../../../spec/conformance/password-policy.json" with {
  type: "json",
};
import {
  type CharOptions,
  defaultCharOptions,
  generateCharacters,
} from "./password.js";

// ADR 0139: the same cases crates/sealed-store runs.
type ClassName = keyof typeof policy.classes;

describe("password policy conformance", () => {
  for (const c of policy.cases) {
    it(c.name, () => {
      const options: CharOptions = { ...defaultCharOptions, ...c.options };
      if (!("expect" in c) || c.expect === undefined) {
        expect(() => generateCharacters(options)).toThrow();
        return;
      }
      const classes = c.expect.classes as ClassName[];
      for (let run = 0; run < 50; run += 1) {
        const out = generateCharacters(options);
        expect([...out]).toHaveLength(c.expect.length);
        const allowed = classes.map((name) => policy.classes[name]).join("");
        for (const ch of out) {
          expect(allowed).toContain(ch);
          if (!c.expect.ambiguous) expect(policy.ambiguous).not.toContain(ch);
        }
        for (const name of classes) {
          expect([...out].some((ch) => policy.classes[name].includes(ch))).toBe(
            true,
          );
        }
      }
    });
  }
});
