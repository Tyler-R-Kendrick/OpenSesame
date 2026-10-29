import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  type DecisionCandidate,
  type DecisionsApi,
  FileRecipeStore,
  type ResetActionDecision,
  createLocalSandbox,
  recordAndApproveRecipe,
} from "../src/index.js";
import { MockResetSite } from "./mock-site.js";
import { PEPPER, runtimeForDriver } from "./runtime.js";

/** A scripted stand-in for the model plane: picks legal candidates only. */
type DecisionCounter = { calls: number };

/** A scripted stand-in for the model plane: picks legal candidates only. */
function scriptedDecisions(counter: DecisionCounter): DecisionsApi {
  const intents: (
    | { kind: string; purpose?: string; label?: string }
    | { finish: true }
  )[] = [
    { kind: "navigate" },
    { kind: "fill-field", purpose: "identifier" },
    { kind: "click", label: "Send reset link" },
    { kind: "await-email-link" },
    { kind: "fill-field", purpose: "new-password" },
    { kind: "submit" },
    { kind: "verify-login" },
    { finish: true },
  ];
  return {
    decide: async ({ observation, candidates }) => {
      counter.calls += 1;
      const intent = intents.shift();
      if (!intent || "finish" in intent)
        return { kind: "finish", observationId: observation.id };
      const match = (candidate: DecisionCandidate) => {
        const action = candidate.action;
        if (action.kind !== intent.kind) return false;
        if (intent.purpose && "purpose" in action)
          return action.purpose === intent.purpose;
        if (intent.label && "ref" in action)
          return (
            observation.fields.find((f) => f.ref === action.ref)?.label ===
            intent.label
          );
        return true;
      };
      const candidate = candidates.find(match);
      if (!candidate)
        throw new Error(`No legal candidate for ${JSON.stringify(intent)}`);
      return {
        kind: "act",
        observationId: observation.id,
        candidateId: candidate.id,
        effectId: candidate.effectId,
      };
    },
  };
}

test("record a ceremony once, replay it model-free from the domain store", async () => {
  const site = new MockResetSite();
  await site.start();
  const directory = await mkdtemp(join(tmpdir(), "cua-record-replay-"));
  const sandbox = createLocalSandbox({ origin: site.origin });
  const counter: DecisionCounter = { calls: 0 };
  try {
    const probe = runtimeForDriver(sandbox.browser, site, {});
    const verify = () =>
      probe.custody.withPassword(async (password) => {
        const response = await fetch(`${site.origin}/login`, {
          method: "POST",
          redirect: "manual",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            email: "person@example.test",
            password,
          }),
        });
        return response.headers.get("location") === "/account";
      });
    const executor = {
      execute: async (action: ResetActionDecision) => {
        switch (action.kind) {
          case "navigate":
            return sandbox.browser.open(`${site.origin}/reset`);
          case "await-email-link":
            return sandbox.browser.open(site.resetLink());
          case "click":
          case "submit":
          case "passkey-prompt":
            return sandbox.browser.click(action.ref);
          case "fill-field":
            if (action.purpose === "identifier")
              return sandbox.browser.fill(action.ref, "person@example.test");
            return probe.custody.withPassword((password) =>
              sandbox.browser.fillSecret(action.ref, password),
            );
          case "verify-login":
            if (!(await verify())) throw new Error("verify failed");
            return;
          case "await-human":
            throw new Error("no human segment in this ceremony");
        }
      },
      handoff: async () => {
        throw new Error("no human segment in this ceremony");
      },
    };
    const store = await FileRecipeStore.open(directory);
    const recorded = await recordAndApproveRecipe(
      store,
      {
        decisions: scriptedDecisions(counter),
        browser: sandbox.browser,
        executor,
        authorize: () => {},
        verify,
        entryUrl: `${site.origin}/reset`,
        allowedOrigins: [site.origin],
      },
      async () => true,
    );
    expect(recorded.review).toBe("approved");
    expect(recorded.domain).toBe("127.0.0.1");
    expect(recorded.steps.map((s) => s.primitive)).toEqual([
      "navigate",
      "fill-field",
      "click",
      "await-email-link",
      "fill-field",
      "submit",
      "verify-login",
    ]);
    expect(site.submissions).toBe(1);
    const files = await readdir(directory);
    expect(files).toEqual([
      `${createHash("sha256").update("127.0.0.1").digest("hex")}.json`,
    ]);
    const stored = await readFile(join(directory, files[0] ?? ""), "utf8");
    expect(stored).not.toContain(PEPPER);
    expect(stored).not.toContain("person@example.test");

    // Replay: fresh password state, recipe from the store, zero model calls.
    site.restorePassword();
    const callsAfterRecord = counter.calls;
    const replayRecipe = await store.get("127.0.0.1");
    if (!replayRecipe) throw new Error("stored recipe missing");
    const replay = runtimeForDriver(sandbox.browser, site, {
      recipe: replayRecipe,
    });
    expect((await replay.runner.start(replay.initial)).status).toBe(
      "succeeded",
    );
    expect(site.submissions).toBe(2);
    expect(counter.calls).toBe(callsAfterRecord);
    await replay.custody.withPassword(async (candidate) => {
      expect(site.accepts(candidate)).toBe(true);
    });

    // Drift fails closed before any submit.
    site.restorePassword();
    site.driftForm();
    const drifted = runtimeForDriver(sandbox.browser, site, {
      recipe: replayRecipe,
    });
    expect((await drifted.runner.start(drifted.initial)).status).toBe("failed");
    expect(site.submissions).toBe(2);
  } finally {
    await sandbox.close().catch(() => {});
    await site.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
