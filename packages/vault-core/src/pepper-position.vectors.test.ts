import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import fixture from "../../../spec/conformance/pepper-position-vectors.json" with {
  type: "json",
};
import { isPepperPosition, splitAtPepper } from "./pepper-position.js";

/** Passwords of every length the vectors cover, ASCII and astral alike. */
function passwords(length: number): string[] {
  const letters = Array.from({ length }, (_, i) =>
    String.fromCodePoint(97 + i),
  );
  const astral = Array.from({ length }, (_, i) =>
    String.fromCodePoint(0x1f600 + i),
  );
  return [letters.join(""), astral.join("")];
}

describe("pepper positions against Python's slicing", () => {
  it("records every length from 0 to the maximum for every expression", () => {
    expect(fixture.cases.length).toBeGreaterThan(800);
    for (const { expression, cuts } of fixture.cases) {
      expect(cuts, expression).toHaveLength(fixture.maxLength + 1);
    }
  });

  it.each(fixture.cases)(
    "cuts as Python does at `$expression`",
    ({ expression, cuts }) => {
      cuts.forEach(([headLength = 0, tailLength = 0], length) => {
        for (const password of passwords(length)) {
          const points = Array.from(password);
          expect(splitAtPepper(password, expression), `${length}`).toEqual({
            head: points.slice(0, headLength).join(""),
            tail: points.slice(points.length - tailLength).join(""),
          });
        }
      });
    },
  );

  it("keeps head and tail from overlapping and from inventing characters", () => {
    for (const { expression } of fixture.cases) {
      for (let length = 0; length <= fixture.maxLength; length++) {
        for (const password of passwords(length)) {
          const { head, tail } = splitAtPepper(password, expression);
          expect(password.startsWith(head)).toBe(true);
          expect(password.endsWith(tail)).toBe(true);
          expect(
            Array.from(head).length + Array.from(tail).length,
          ).toBeLessThanOrEqual(length);
        }
      }
    }
  });

  it("calls an expression valid exactly when it is not just the end by default", () => {
    for (const valid of [
      "",
      "end",
      "3",
      "-2",
      "2:5",
      ":4",
      "-3:",
      "[2:5]",
      " 3 ",
    ]) {
      expect(isPepperPosition(valid), valid).toBe(true);
    }
    for (const invalid of ["abc", "1:2:3", "3.5", "1_0", " 3", "٣", "[3"]) {
      expect(isPepperPosition(invalid), invalid).toBe(false);
    }
  });
});

describe("the recorded vectors", () => {
  it("are exactly what the Python reference writes", () => {
    const script = fileURLToPath(
      new URL(
        "../../../scripts/test/pepper-position-reference.py",
        import.meta.url,
      ),
    );
    const run = spawnSync("python3", ["-I", script, "--check"], {
      encoding: "utf8",
    });
    expect(run.error, "python3 is needed to check the vectors").toBeUndefined();
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
  });
});
