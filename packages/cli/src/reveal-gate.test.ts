import { afterEach, describe, expect, it } from "vitest";
import gate from "../../../spec/conformance/cli-reveal-gate.json" with {
  type: "json",
};
import {
  type HumanRevealRequest,
  assertHumanReveal,
  detectAgentContext,
  humanRevealRefusal,
} from "./reveal-gate.js";

function restoreEnv(name: string, previous: string | undefined): void {
  if (previous === undefined) Reflect.deleteProperty(process.env, name);
  else process.env[name] = previous;
}

describe("cli reveal gate conformance", () => {
  for (const caseRow of gate.cases) {
    it(caseRow.id, () => {
      const env = { ...process.env };
      if (caseRow.agentContext) {
        env.OPENSESAME_AGENT_LAUNCH_HANDLE = "fixture-handle";
      } else {
        env.OPENSESAME_AGENT_LAUNCH_HANDLE = undefined;
      }
      const request: HumanRevealRequest = {
        verb: caseRow.reference ? "read" : "env-resolve",
        reveal: caseRow.reveal,
        desktop: caseRow.desktop,
        reference: caseRow.reference ?? undefined,
        env,
        stdinIsTty: caseRow.stdinTty,
        stdoutIsTty: caseRow.stdoutTty,
      };
      const refusal = humanRevealRefusal(request);
      if (caseRow.expect === "refuse") {
        expect(refusal).toBeTruthy();
        expect(() => assertHumanReveal(request)).toThrow();
      } else {
        expect(refusal).toBeUndefined();
        expect(() => assertHumanReveal(request)).not.toThrow();
      }
    });
  }

  it("detects verified agent markers only (refuse-only)", () => {
    const launch = process.env.OPENSESAME_AGENT_LAUNCH_HANDLE;
    const client = process.env.OPENSESAME_AGENT_CLIENT_ID;
    const claude = process.env.CLAUDECODE;
    try {
      process.env.OPENSESAME_AGENT_LAUNCH_HANDLE = "h";
      expect(detectAgentContext()).toBe(true);
      Reflect.deleteProperty(process.env, "OPENSESAME_AGENT_LAUNCH_HANDLE");
      process.env.OPENSESAME_AGENT_CLIENT_ID = "c";
      expect(detectAgentContext()).toBe(true);
      Reflect.deleteProperty(process.env, "OPENSESAME_AGENT_CLIENT_ID");
      process.env.CLAUDECODE = "1";
      expect(detectAgentContext()).toBe(true);
      Reflect.deleteProperty(process.env, "CLAUDECODE");
      expect(detectAgentContext()).toBe(false);
    } finally {
      restoreEnv("OPENSESAME_AGENT_LAUNCH_HANDLE", launch);
      restoreEnv("OPENSESAME_AGENT_CLIENT_ID", client);
      restoreEnv("CLAUDECODE", claude);
    }
  });
});

describe("cli reveal gate subprocess refusal", () => {
  afterEach(() => {
    Reflect.deleteProperty(process.env, "OPENSESAME_AGENT_LAUNCH_HANDLE");
  });

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
