import { afterEach, describe, expect, it } from "vitest";
import gate from "../../../spec/conformance/cli-reveal-gate.json" with {
  type: "json",
};
import {
  type HumanRevealRequest,
  assertHumanReveal,
  humanRevealRefusal,
} from "./reveal-gate.js";

describe("cli reveal gate conformance", () => {
  for (const caseRow of gate.cases) {
    it(caseRow.id, () => {
      const request: HumanRevealRequest = {
        verb: caseRow.reference ? "read" : "env-resolve",
        reveal: caseRow.reveal,
        desktop: caseRow.desktop,
        reference: caseRow.reference ?? undefined,
        stdinIsTty: caseRow.stdinTty,
        stdoutIsTty: caseRow.stdoutTty,
      };
      const refusal = humanRevealRefusal(request);
      if (caseRow.expect === "refuse") {
        expect(refusal).toBeTruthy();
      } else {
        expect(refusal).toBeUndefined();
      }
    });
  }

  it("app integration approve allows reveal", async () => {
    const request: HumanRevealRequest = {
      verb: "read",
      reveal: true,
      desktop: true,
      reference: "op://v/i/f",
      stdinIsTty: true,
      stdoutIsTty: true,
      appIntegration: {
        ensureReveal: async () => "approve",
      },
    };
    await expect(assertHumanReveal(request)).resolves.toBeUndefined();
  });

  it("app integration deny refuses reveal", async () => {
    const request: HumanRevealRequest = {
      verb: "read",
      reveal: true,
      desktop: true,
      reference: "op://v/i/f",
      stdinIsTty: true,
      stdoutIsTty: true,
      appIntegration: {
        ensureReveal: async () => "deny",
      },
    };
    await expect(assertHumanReveal(request)).rejects.toThrow(/denied/i);
  });
});

describe("cli reveal gate subprocess refusal", () => {
  afterEach(() => {
    Reflect.deleteProperty(process.env, "OPENSESAME_CLI_APP_INTEGRATION_SEAM");
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
