import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  AgentBrowser,
  type DecisionCandidate,
  type DecisionsApi,
  FileRecipeStore,
  type Observation,
  type ResetActionDecision,
  createLocalSandbox,
  recordAndApproveRecipe,
} from "../src/index.js";
import { MockResetSite } from "./mock-site.js";
import { runtimeForDriver } from "./runtime.js";

function refFor(obs: Observation, kind: string, label: string): string {
  const field = obs.fields.find((f) => f.kind === kind && f.label === label);
  if (!field) throw new Error(`Missing ${kind} ${label}`);
  return field.ref;
}

type Intent =
  | { kind: string; purpose?: string; label?: string }
  | { handoff: "captcha" }
  | { finish: true };

type DecisionCounter = { calls: number };

/** A scripted stand-in for the model plane: picks legal candidates only. */
function scriptedDecisions(counter: DecisionCounter): DecisionsApi {
  const intents: Intent[] = [
    { kind: "navigate" },
    { kind: "fill-field", purpose: "identifier" },
    { kind: "click", label: "Send reset link" },
    { kind: "await-email-link" },
    { handoff: "captcha" },
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
      if ("handoff" in intent)
        return {
          kind: "handoff",
          observationId: observation.id,
          challenge: intent.handoff,
        };
      const candidate = candidates.find((entry: DecisionCandidate) => {
        const action = entry.action;
        if (action.kind !== intent.kind) return false;
        if (intent.purpose && "purpose" in action)
          return action.purpose === intent.purpose;
        if (intent.label && "ref" in action)
          return (
            observation.fields.find((f) => f.ref === action.ref)?.label ===
            intent.label
          );
        return true;
      });
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

test("full chain: kickoff in a zero-provision sandbox, human takeover mid-ceremony, recorded recipe replays the same takeover", async () => {
  const site = new MockResetSite();
  await site.start();
  site.setChallenge("captcha");
  const directory = await mkdtemp(join(tmpdir(), "cua-full-chain-"));
  const sandbox = createLocalSandbox({ origin: site.origin });
  const humanConfig: ConstructorParameters<typeof AgentBrowser>[0] = {
    executable: process.env.AGENT_BROWSER ?? "agent-browser",
    session: sandbox.session,
    allowedDomains: [...sandbox.allowedDomains],
  };
  if (process.env.AGENT_BROWSER_CHROME)
    humanConfig.browserExecutable = process.env.AGENT_BROWSER_CHROME;
  const human = new AgentBrowser(humanConfig);
  const clearChallengeAsHuman = async () => {
    const page = await human.snapshot();
    await human.click(refFor(page, "button", "Challenge completed"));
  };
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
    const recorded = await recordAndApproveRecipe(
      await FileRecipeStore.open(directory),
      {
        decisions: scriptedDecisions(counter),
        browser: sandbox.browser,
        executor: {
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
                  return sandbox.browser.fill(
                    action.ref,
                    "person@example.test",
                  );
                return probe.custody.withPassword((password) =>
                  sandbox.browser.fillSecret(action.ref, password),
                );
              case "verify-login":
                if (!(await verify())) throw new Error("verify failed");
                return;
              case "await-human":
                throw new Error("handoff is not an execute action");
            }
          },
          handoff: clearChallengeAsHuman,
        },
        authorize: () => {},
        verify,
        entryUrl: `${site.origin}/reset`,
        allowedOrigins: [site.origin],
      },
      async () => true,
    );
    const humanStep = recorded.steps.find((s) => s.primitive === "await-human");
    expect(humanStep?.challenge).toBe("captcha");
    expect(humanStep?.postcondition?.expectedLabels.length).toBeGreaterThan(0);
    expect(site.submissions).toBe(1);

    site.restorePassword();
    site.setChallenge("captcha");
    const callsAfterRecord = counter.calls;
    const replay = runtimeForDriver(sandbox.browser, site, {
      recipe: recorded,
      takeoverResume: clearChallengeAsHuman,
    });
    expect((await replay.runner.start(replay.initial)).status).toBe(
      "awaiting_human",
    );
    expect(replay.challenges).toEqual(["captcha"]);
    expect((await replay.runner.resumeAfterHuman("run-1")).status).toBe(
      "succeeded",
    );
    expect(site.submissions).toBe(2);
    expect(counter.calls).toBe(callsAfterRecord);
    await replay.custody.withPassword(async (candidate) => {
      expect(site.accepts(candidate)).toBe(true);
    });
  } finally {
    await sandbox.close().catch(() => {});
    await site.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
