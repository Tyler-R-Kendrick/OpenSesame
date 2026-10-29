import { createRequire } from "node:module";
import {
  type BrowserDriver,
  type HumanTakeoverPort,
  type LocalSandbox,
  createLocalSandbox,
  detectChallenge,
} from "@opensesame/cua-password-reset";
import type { ResetRuntimeContext } from "./password-reset-runtime.js";

export interface LocalSandboxPort {
  browser: BrowserDriver;
  session: string;
  close(): Promise<void>;
}

type VerificationOptions = {
  sandbox?: LocalSandboxPort;
  verificationSandbox?: LocalSandboxPort;
};

export function localAgentBrowserExecutable(
  context: ResetRuntimeContext,
): string {
  return (
    context.loaded.config.runtime.browser ??
    createRequire(import.meta.url).resolve("agent-browser/bin/agent-browser.js")
  );
}

export function resetRecipeHostnames(
  recipe: ResetRuntimeContext["run"]["recipe"],
): string[] {
  return recipe.allowedOrigins.map((origin) => new URL(origin).hostname);
}

export function createLocalLoginVerifier(
  context: ResetRuntimeContext,
  options: VerificationOptions,
  takeover: HumanTakeoverPort,
) {
  const { run, candidate, item } = context;
  const owned = !options.verificationSandbox && !options.sandbox;
  let sandbox: LocalSandboxPort | undefined;
  const close = async () => {
    const current = sandbox;
    sandbox = undefined;
    await current?.close().catch(() => {});
  };
  return {
    close,
    verifyLogin: async (): Promise<boolean | null> => {
      sandbox ??=
        options.verificationSandbox ??
        options.sandbox ??
        createLocalSandbox({
          origin: run.origin,
          extraAllowedDomains: resetRecipeHostnames(run.recipe),
          executable: localAgentBrowserExecutable(context),
        });
      const verified = await probeLogin(
        sandbox,
        candidate,
        item.username ?? "",
        run,
        takeover,
      );
      if (verified !== true && owned) await close();
      return verified;
    },
  };
}

async function probeLogin(
  sandbox: LocalSandboxPort,
  candidate: ResetRuntimeContext["candidate"],
  username: string,
  run: ResetRuntimeContext["run"],
  takeover: HumanTakeoverPort,
): Promise<boolean | null> {
  const { origin } = run;
  const { verification } = run.recipe;
  if (!verification) return null;
  const browser = sandbox.browser;
  const login = new URL(verification.loginPath, origin).href;
  await browser.open(login);
  const form = await browser.snapshot();
  if (form.origin !== new URL(origin).origin) return null;
  if (browser.pageUrl && (await browser.pageUrl()) !== login) return null;
  const email = unique(form.fields, ["email"]) ?? unique(form.fields, ["text"]);
  const password = unique(form.fields, ["password"]);
  const button = unique(
    form.fields,
    ["button", "link"],
    verification.loginLabel,
  );
  if (!email || !password || !button) return null;
  await browser.fill(email.ref, username);
  await candidate.withPassword((value) =>
    browser.fillSecret(password.ref, value),
  );
  await browser.click(button.ref);
  const after = await browser.snapshot();
  if (after.origin !== new URL(origin).origin) return null;
  const challenge = detectChallenge(after);
  if (challenge) {
    await takeover.handoff(challenge, run);
    await takeover.resume(challenge, run);
  }
  const settled = challenge ? await browser.snapshot() : after;
  if (
    settled.origin !== new URL(origin).origin ||
    !browser.pageUrl ||
    (await browser.pageUrl()) !== new URL(verification.path, origin).href
  )
    return null;
  return settled.fields.some(
    (field) =>
      (field.kind === "button" || field.kind === "link") &&
      field.label === verification.expectedLabel,
  );
}

function unique(
  fields: { ref: string; kind: string; label: string }[],
  kinds: string[],
  label?: string,
): { ref: string } | null {
  const matches = fields.filter(
    (field) =>
      kinds.includes(field.kind) &&
      (label === undefined || field.label === label),
  );
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

export type { LocalSandbox };
