import { randomUUID } from "node:crypto";
import {
  SandboxClaimRequiredError,
  type SandboxProvider,
} from "@opensesame/agent-sandboxes";
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
  const { sandbox, verifierOptions, getVerificationSession } =
    await prepareSandboxes(context, options, notify);
  const verifier = createLocalLoginVerifier(context, verifierOptions, {
    handoff: async (challenge, current) => {
      if (options.takeover) return options.takeover.handoff(challenge, current);
      const verificationSession = getVerificationSession();
      const session =
        verificationSession &&
        /^[A-Za-z0-9_-]{1,128}$/u.test(verificationSession)
          ? ` Session ${verificationSession}.`
          : "";
      notify(
        `Password verification needs you (${challenge}).${session} Complete it in the verification browser, then press Enter.`,
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
  const closeQuietly = () => closeSandboxes(sandbox, verifier.close, notify);
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
    promoteCandidate: async () => {
      if (!(await closeQuietly())) throw new Error("Sandbox cleanup failed");
    },
    compensate: async () => {
      await closeQuietly();
      return "unsupported";
    },
  };
}

async function closeSandboxes(
  sandbox: LocalSandboxPort,
  closeVerifier: () => Promise<void>,
  notify: (message: string) => void,
): Promise<boolean> {
  const results = await Promise.allSettled([sandbox.close(), closeVerifier()]);
  const failed = results.some((result) => result.status === "rejected");
  if (failed)
    notify(
      "Sandbox cleanup failed; a remote session may remain. Retry cleanup.",
    );
  return !failed;
}

async function prepareSandboxes(
  context: ResetRuntimeContext,
  options: LocalRuntimeOptions,
  notify: (message: string) => void,
) {
  const providerId = context.loaded.config.runtime.provider ?? "local";
  let provider: SandboxProvider | undefined;
  const getProvider = () => {
    provider ??= (
      options.createProvider ??
      ((id) => createSandboxProvider(id, context.loaded.directory))
    )(providerId);
    return provider;
  };
  const sandbox = await sandboxForRun(
    context,
    options,
    providerId,
    notify,
    getProvider,
  );
  let verificationSession: string | undefined;
  const getVerificationSession = () => verificationSession;
  if (providerId === "local")
    return { sandbox, verifierOptions: options, getVerificationSession };
  if (options.verificationSandbox) {
    if (sameSandbox(options.verificationSandbox, sandbox)) {
      await closeSandboxes(sandbox, async () => {}, notify);
      throw new Error("Password verification requires a separate sandbox");
    }
    verificationSession = options.verificationSandbox.session;
    return { sandbox, verifierOptions: options, getVerificationSession };
  }
  const verifierOptions = {
    createVerificationSandbox: async () => {
      const verification = await allocateProviderSandbox(
        context,
        notify,
        getProvider(),
        `cua-verify-${randomUUID()}`,
      );
      if (sameSandbox(verification, sandbox)) {
        notify(
          "Sandbox provider reused the reset session; verification was refused.",
        );
        throw new Error("Password verification requires a separate sandbox");
      }
      verificationSession = verification.session;
      return verification;
    },
    onCleanupFailure: () =>
      notify(
        "Sandbox cleanup failed; a remote session may remain. Retry cleanup.",
      ),
  };
  return { sandbox, verifierOptions, getVerificationSession };
}

function sameSandbox(
  first: LocalSandboxPort,
  second: LocalSandboxPort,
): boolean {
  return first.session === second.session || first.browser === second.browser;
}

async function sandboxForRun(
  context: ResetRuntimeContext,
  options: LocalRuntimeOptions,
  providerId: string,
  notify: (message: string) => void,
  getProvider: () => SandboxProvider,
): Promise<LocalSandboxPort> {
  if (options.sandbox) return options.sandbox;
  if (providerId !== "local")
    return allocateProviderSandbox(
      context,
      notify,
      getProvider(),
      `cua-${context.run.id}`,
    );
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
  notify: (message: string) => void,
  provider: SandboxProvider,
  session: string,
): Promise<LocalSandboxPort> {
  const { run } = context;
  let allocation;
  try {
    allocation = await provider.allocate({
      origin: run.origin,
      extraAllowedDomains: resetRecipeHostnames(run.recipe),
      session,
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
  let closing: Promise<void> | undefined;
  return {
    browser: allocation.browser,
    session: allocation.session,
    close: async () => {
      if (closed) return;
      closing ??= Promise.resolve()
        .then(() => allocation.close())
        .then(
          () => {
            closed = true;
          },
          (error: unknown) => {
            closing = undefined;
            throw error;
          },
        );
      await closing;
    },
  };
}

/** Adapter-module surface, so this file can also be loaded by path. */
export const createPasswordResetEffects = createLocalPasswordResetEffects;

export function validatePasswordResetConfiguration(): void {}
