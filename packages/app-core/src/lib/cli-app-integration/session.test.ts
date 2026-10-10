import { describe, expect, it } from "vitest";
import gate from "../../../../../spec/conformance/cli-app-integration.json" with {
  type: "json",
};
import { CliAppIntegrationStore } from "./session.js";

describe("cli app integration session store", () => {
  for (const caseRow of gate.sessionCases) {
    it(caseRow.id, () => {
      let now = 1_000_000;
      const store = new CliAppIntegrationStore(() => now);
      const terminalSessionId = caseRow.terminalSessionId;
      const verb = "read";
      if (caseRow.action === "approve") {
        const pending = store.ensure(terminalSessionId, verb);
        expect(pending.status).toBe("pending");
        const requestId = pending.requestId;
        expect(requestId).toBeTruthy();
        const approved = store.approve(requestId ?? "", terminalSessionId);
        expect(approved.status).toBe("approved");
        if (caseRow.idlePastSeconds) {
          now += caseRow.idlePastSeconds * 1000;
        }
        const queryId =
          caseRow.queryAs === "other"
            ? (caseRow.otherTerminalSessionId ?? "missing")
            : terminalSessionId;
        const check = store.ensure(queryId, verb);
        expect(check.status).toBe(caseRow.expectEnsure);
        return;
      }
      if (caseRow.action === "deny") {
        const pending = store.ensure(terminalSessionId, verb);
        const denied = store.deny(pending.requestId ?? "", terminalSessionId);
        expect(denied.status).toBe("denied");
        expect(store.ensure(terminalSessionId, verb).status).toBe("denied");
      }
    });
  }

  it("refuses approve for a mismatched terminal session", () => {
    const store = new CliAppIntegrationStore();
    const pending = store.ensure("term-x", "read");
    expect(store.approve(pending.requestId ?? "", "term-y").status).toBe(
      "wrongSession",
    );
  });
});
