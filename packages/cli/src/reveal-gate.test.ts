import { describe, expect, it } from "vitest";
import gate from "../../../spec/conformance/cli-reveal-gate.json" with {
  type: "json",
};
import {
  type HumanRevealRequest,
  assertHumanReveal,
  humanRevealRefusal,
} from "./reveal-gate.js";

function restoreEnv(name: string, previous: string | undefined): void {
  if (previous === undefined) Reflect.deleteProperty(process.env, name);
  else process.env[name] = previous;
}

function assertStaticHumanReveal(request: HumanRevealRequest): void {
  const refusal = humanRevealRefusal(request);
  if (refusal) throw new Error(refusal);
}

const AGENT_MARKERS: ReadonlyArray<{ name: string; value: string }> = [
  { name: "CURSOR_AGENT", value: "1" },
  { name: "CI", value: "true" },
  { name: "GITHUB_ACTIONS", value: "true" },
  { name: "OPENSESAME_AGENT_LAUNCH_HANDLE", value: "fixture-handle" },
];

function envWithMarkers(
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env = { ...base };
  for (const { name, value } of AGENT_MARKERS) {
    env[name] = value;
  }
  return env;
}

describe("cli reveal gate conformance", () => {
  for (const caseRow of gate.cases) {
    it(caseRow.id, () => {
      const request: HumanRevealRequest = {
        verb: caseRow.reference ? "read" : "env-resolve",
        reveal: caseRow.reveal,
        desktop: caseRow.desktop,
        reference: caseRow.reference ?? undefined,
        env: process.env,
        stdinIsTty: caseRow.stdinTty,
        stdoutIsTty: caseRow.stdoutTty,
      };
      const refusal = humanRevealRefusal(request);
      if (caseRow.expect === "refuse") {
        expect(refusal).toBeTruthy();
        expect(() => assertStaticHumanReveal(request)).toThrow();
      } else {
        expect(refusal).toBeUndefined();
        expect(() => assertStaticHumanReveal(request)).not.toThrow();
      }
    });
  }
});

describe("cli reveal gate — agent env markers are not a gate", () => {
  const terminalRead: HumanRevealRequest = {
    verb: "read",
    reveal: true,
    desktop: true,
    reference: "op://v/i/f",
    stdinIsTty: true,
    stdoutIsTty: true,
  };

  it("does not refuse the static gate when CI-style markers are set", () => {
    const request = { ...terminalRead, env: envWithMarkers() };
    expect(humanRevealRefusal(request)).toBeUndefined();
  });

  it("refuses without app integration approval even when markers are set", async () => {
    const request = {
      ...terminalRead,
      env: envWithMarkers(),
      appIntegration: { ensureReveal: async () => "deny" },
    };
    await expect(assertHumanReveal(request)).rejects.toThrow(/denied/i);
  });

  it("reveals with app integration approval even when markers are set", async () => {
    const request = {
      ...terminalRead,
      env: envWithMarkers(),
      appIntegration: { ensureReveal: async () => "approve" },
    };
    await expect(assertHumanReveal(request)).resolves.toBeUndefined();
  });

  it("refuses without approval when markers are absent", async () => {
    const saved = new Map<string, string | undefined>();
    for (const { name } of AGENT_MARKERS) {
      saved.set(name, process.env[name]);
      Reflect.deleteProperty(process.env, name);
    }
    try {
      const request = {
        ...terminalRead,
        appIntegration: { ensureReveal: async () => "deny" },
      };
      await expect(assertHumanReveal(request)).rejects.toThrow(/denied/i);
    } finally {
      for (const [name, previous] of saved) {
        restoreEnv(name, previous);
      }
    }
  });
});

describe("cli reveal gate subprocess refusal", () => {
  it("refuses read when stdout is piped", () => {
    expect(
      humanRevealRefusal({
        verb: "read",
        reveal: true,
        desktop: true,
        reference: "op://v/i/f",
        stdinIsTty: true,
        stdoutIsTty: false,
      }),
    ).toMatch(/stdout/);
  });
});
