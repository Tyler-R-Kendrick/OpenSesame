import {
  BrowserStepExecutor,
  type BrowserStepPorts,
  type HumanTakeoverPort,
  type LocalSandbox,
  type MailboxPort,
  type ResetEffects,
  type ResetRun,
  createLocalSandbox,
} from "@opensesame/cua-password-reset";
import { emitStderrLine } from "./output.js";
import type { ResetRuntimeContext } from "./password-reset-runtime.js";
import { readPasswordFromTty } from "./tty-password.js";

export interface LocalRuntimeOptions {
  sandbox?: LocalSandbox;
  mailbox?: MailboxPort;
  takeover?: HumanTakeoverPort;
  verifyLogin?: () => Promise<boolean | null>;
  /** Read one non-echoed line (reset link / takeover acknowledgement). */
  readSecretLine?: (prompt: string) => Promise<string>;
  notify?: (message: string) => void;
}

/**
 * Bundled zero-provision runtime: the reset runs in an ephemeral local
 * agent-browser sandbox on this device. No external adapter module, cloud
 * runtime account, or model plane is required to replay an approved recipe.
 * The candidate derives from the vault's current (already rotated) method,
 * so backup/promotion need no vault write here; compensation is unsupported
 * because the previous site password is never available to the agent.
 */
export async function createLocalPasswordResetEffects(
  context: ResetRuntimeContext,
  options: LocalRuntimeOptions = {},
): Promise<ResetEffects> {
  const { run, candidate, item } = context;
  if (!item.username) throw new Error("The account item has no username");
  const readSecretLine =
    options.readSecretLine ?? ((prompt) => readPasswordFromTty(prompt));
  const notify = options.notify ?? emitStderrLine;
  const sandbox =
    options.sandbox ??
    createLocalSandbox({
      origin: run.origin,
      extraAllowedDomains: resetRecipeHostnames(run.recipe),
      // Stable per run so a later `resume` invocation rejoins the same
      // agent-browser session a human was handed.
      session: `cua-${run.id}`,
      ...(context.loaded.config.runtime.browser
        ? { executable: context.loaded.config.runtime.browser }
        : {}),
    });
  const verifyLogin =
    options.verifyLogin ??
    (() => probeLogin(sandbox, candidate, item.username, run.origin));
  const ports: BrowserStepPorts = {
    identifier: async () => item.username,
    mailbox: options.mailbox ?? {
      resetLink: () =>
        readSecretLine("Paste the password-reset link from your email: "),
    },
    candidate,
    authorizeProxy: () => {
      throw new Error("The bundled local runtime has no proxy lane");
    },
    takeover: options.takeover ?? {
      handoff: async (challenge) => {
        notify(
          `Password reset needs you (${challenge}). Session ${sandbox.session} is parked; complete the challenge, then run resume.`,
        );
      },
      resume: async () => {
        await readSecretLine("Press Enter once the challenge is complete: ");
      },
    },
    verifyLogin: async () => (await verifyLogin()) === true,
  };
  if (run.recipe.steps.length > context.loaded.config.runtime.maxSteps)
    throw new Error("The approved recipe exceeds the configured step budget");
  const executor = new BrowserStepExecutor(sandbox.browser, ports);
  const closeQuietly = async () => {
    await sandbox.close().catch(() => {});
  };
  return {
    execute: async (step, current, effect) => {
      try {
        const receipt = await executor.execute(step, current, effect);
        if (receipt.outcome === "failed_before_submit") await closeQuietly();
        return receipt;
      } catch (error) {
        await closeQuietly();
        throw error;
      }
    },
    backupCandidate: async () => {},
    verifyCandidate: async () => {
      try {
        const verified = await verifyLogin();
        return verified === true
          ? "verified"
          : verified === false
            ? "not_active"
            : "unknown";
      } catch {
        return "unknown";
      }
    },
    promoteCandidate: closeQuietly,
    compensate: async () => {
      await closeQuietly();
      return "unsupported";
    },
  };
}

/** Adapter-module surface, so this file can also be loaded by path. */
export const createPasswordResetEffects = createLocalPasswordResetEffects;

export function validatePasswordResetConfiguration(): void {}

async function probeLogin(
  sandbox: LocalSandbox,
  candidate: ResetRuntimeContext["candidate"],
  username: string,
  origin: string,
): Promise<boolean | null> {
  const browser = sandbox.browser;
  const login = new URL("/login", origin).href;
  await browser.open(login);
  const form = await browser.snapshot();
  if (form.origin !== new URL(origin).origin) return null;
  if (browser.pageUrl && (await browser.pageUrl()) !== login) return null;
  const email = unique(form.fields, ["email", "text"]);
  const password = unique(form.fields, ["password"]);
  const button = unique(form.fields, ["button", "link"]);
  if (!email || !password || !button) return null;
  await browser.fill(email.ref, username);
  await candidate.withPassword((value) =>
    browser.fillSecret(password.ref, value),
  );
  await browser.click(button.ref);
  const after = await browser.snapshot();
  if (after.origin !== new URL(origin).origin) return null;
  if (
    !browser.pageUrl ||
    (await browser.pageUrl()) !== new URL("/", origin).href
  )
    return null;
  return !after.fields.some((field) => field.kind === "password");
}

export function resetRecipeHostnames(recipe: ResetRun["recipe"]): string[] {
  return recipe.allowedOrigins.map((origin) => new URL(origin).hostname);
}

function unique(
  fields: { ref: string; kind: string }[],
  kinds: string[],
): { ref: string } | null {
  const matches = fields.filter((field) => kinds.includes(field.kind));
  return matches.length === 1 ? (matches[0] ?? null) : null;
}
