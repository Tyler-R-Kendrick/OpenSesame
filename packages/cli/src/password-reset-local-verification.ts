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
  createVerificationSandbox?: () => Promise<LocalSandboxPort>;
  onCleanupFailure?: () => void;
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
  let verifying = false;
  const close = async () => {
    const current = sandbox;
    if (!current) return;
    try {
      await current.close();
    } catch (error) {
      options.onCleanupFailure?.();
      throw error;
    }
    if (sandbox === current) sandbox = undefined;
  };
  return {
    close,
    verifyLogin: async (): Promise<boolean | null> => {
      if (verifying)
        throw new Error("Password verification already in progress");
      verifying = true;
      try {
        // A previous close failure must be retried before starting another
        // verification; never reuse its potentially authenticated browser.
        if (owned && sandbox) await close();
        sandbox ??=
          options.verificationSandbox ??
          options.sandbox ??
          (await (options.createVerificationSandbox?.() ??
            Promise.resolve(
              createLocalSandbox({
                origin: run.origin,
                extraAllowedDomains: resetRecipeHostnames(run.recipe),
                executable: localAgentBrowserExecutable(context),
              }),
            )));
        try {
          return await probeLogin(
            sandbox,
            candidate,
            item.username ?? "",
            run,
            takeover,
          );
        } finally {
          if (owned) await close();
        }
      } finally {
        verifying = false;
      }
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
