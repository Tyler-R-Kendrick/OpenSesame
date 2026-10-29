import { SandboxClaimRequiredError } from "@opensesame/agent-sandboxes";
import {
  BrowserStepExecutor,
  type BrowserStepPorts,
  type HumanTakeoverPort,
  type MailboxPort,
  type ResetEffects,
  createLocalSandbox,
} from "@opensesame/cua-password-reset";
import { emitStderrLine } from "./output.js";
import {
  createLocalLoginVerifier,
  localAgentBrowserExecutable,
  resetRecipeHostnames,
} from "./password-reset-local-verification.js";
import type { ResetRuntimeContext } from "./password-reset-runtime.js";
import {
  type SandboxProviderFactory,
  createSandboxProvider,
} from "./password-reset-sandbox-provider.js";
import { readPasswordFromTty } from "./tty-password.js";

export {
  type LocalSandboxPort,
  resetRecipeHostnames,
} from "./password-reset-local-verification.js";
import type { LocalSandboxPort } from "./password-reset-local-verification.js";

export interface LocalRuntimeOptions {
  sandbox?: LocalSandboxPort;
  /** Build the configured non-local sandbox provider (tests). */
  createProvider?: SandboxProviderFactory;
  verificationSandbox?: LocalSandboxPort;
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
  if (!run.recipe.verification)
    throw new Error("The bundled runtime requires verification metadata");
  if (!item.username) throw new Error("The account item has no username");
  if (run.recipe.steps.length > context.loaded.config.runtime.maxSteps)
    throw new Error("The approved recipe exceeds the configured step budget");
  const readSecretLine =
    options.readSecretLine ?? ((prompt) => readPasswordFromTty(prompt));
  const notify = options.notify ?? emitStderrLine;
  const providerId = context.loaded.config.runtime.provider ?? "local";
  const sandbox = await sandboxForRun(context, options, providerId, notify);
  // Remote lanes verify in the allocated browser; the local lane keeps
  // its fresh verification session. Explicit test sandboxes win.
  const verifierOptions =
    providerId === "local" || options.sandbox || options.verificationSandbox
      ? options
      : { ...options, verificationSandbox: sandbox };
  const verifier = createLocalLoginVerifier(context, verifierOptions, {
    handoff: async (challenge, current) => {
      if (options.takeover) return options.takeover.handoff(challenge, current);
      notify(
        `Password verification needs you (${challenge}). Complete it in the verification browser, then press Enter.`,
      );
    },
    resume: (challenge, current) => ports.takeover.resume(challenge, current),
  });
  const verifyLogin = options.verifyLogin ?? verifier.verifyLogin;
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
  const executor = new BrowserStepExecutor(sandbox.browser, ports);
  const closeQuietly = async () => {
    await Promise.allSettled([sandbox.close(), verifier.close()]);
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

async function sandboxForRun(
  context: ResetRuntimeContext,
  options: LocalRuntimeOptions,
  providerId: string,
  notify: (message: string) => void,
): Promise<LocalSandboxPort> {
  if (options.sandbox) return options.sandbox;
  if (providerId !== "local")
    return allocateProviderSandbox(context, options, notify);
  const { run } = context;
  return createLocalSandbox({
    origin: run.origin,
    extraAllowedDomains: resetRecipeHostnames(run.recipe),
    // Stable per run so a later `resume` invocation rejoins the same
    // agent-browser session a human was handed.
    session: `cua-${run.id}`,
    executable: localAgentBrowserExecutable(context),
  });
}

/**
 * Allocate a non-local sandbox for the run. A provider claim (Boat
 * registration, billing checkout) is a human intervention: print the
 * link and code, then fail so the person can finish and retry.
 */
async function allocateProviderSandbox(
  context: ResetRuntimeContext,
  options: LocalRuntimeOptions,
  notify: (message: string) => void,
): Promise<LocalSandboxPort> {
  const { run } = context;
  const providerId = context.loaded.config.runtime.provider ?? "local";
  const provider = (
    options.createProvider ??
    ((id) => createSandboxProvider(id, context.loaded.directory))
  )(providerId);
  let allocation;
  try {
    allocation = await provider.allocate({
      origin: run.origin,
      extraAllowedDomains: resetRecipeHostnames(run.recipe),
      session: `cua-${run.id}`,
    });
  } catch (error) {
    if (error instanceof SandboxClaimRequiredError) {
      const code = error.userCode ? ` and enter code ${error.userCode}` : "";
      notify(
        `Sandbox allocation needs you: open ${error.verificationUri}${code}, then retry.`,
      );
      throw new Error(
        `Sandbox allocation needs a person first: ${error.verificationUri}`,
      );
    }
    throw error;
  }
  let closed = false;
  return {
    browser: allocation.browser,
    session: allocation.session,
    close: async () => {
      if (closed) return;
      closed = true;
      await allocation.close();
    },
  };
}

/** Adapter-module surface, so this file can also be loaded by path. */
export const createPasswordResetEffects = createLocalPasswordResetEffects;

export function validatePasswordResetConfiguration(): void {}
