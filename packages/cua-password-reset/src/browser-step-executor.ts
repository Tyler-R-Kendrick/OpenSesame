import type { BrowserDriver } from "./agent-browser.js";
import { detectChallenge } from "./decisions.js";
import { stepDrift } from "./recipe.js";
import { type CandidateCustody, assertProxyLane } from "./secrets.js";
import type {
  HumanChallenge,
  ProxyProof,
  RecipeStep,
  ResetRun,
  StepReceipt,
} from "./types.js";

export interface MailboxPort {
  resetLink(): Promise<string>;
}

export type PasswordCall = <T>(
  use: (password: string) => Promise<T>,
) => Promise<T>;

export interface ExactFormProxyPort {
  readonly exactFormSubstitution: true;
  arm(input: {
    run: ResetRun;
    proof: ProxyProof;
    synthetic: string;
    withRealPassword: PasswordCall;
  }): Promise<void>;
}

export interface HumanTakeoverPort {
  handoff(challenge: HumanChallenge, run: ResetRun): Promise<void>;
  resume(challenge: HumanChallenge, run: ResetRun): Promise<void>;
}

export interface BrowserStepPorts {
  identifier(): Promise<string>;
  mailbox: MailboxPort;
  candidate: Pick<CandidateCustody, "withSynthetic" | "withPassword">;
  takeover: HumanTakeoverPort;
  authorizeProxy(): void;
  proxy?: ExactFormProxyPort;
  verifyLogin(run: ResetRun): Promise<boolean>;
}

export class BrowserStepExecutor {
  constructor(
    private readonly browser: BrowserDriver,
    private readonly ports: BrowserStepPorts,
  ) {}

  async execute(
    step: RecipeStep,
    run: ResetRun,
    context = { effectId: "direct", attempt: 1 },
  ): Promise<StepReceipt> {
    const done = { stepId: step.id, outcome: "completed" } as const;
    if (
      [
        "await-human",
        "enter-email-code",
        "enter-TOTP",
        "passkey-prompt",
      ].includes(step.primitive)
    )
      return this.challenge(step, run, context.attempt);
    switch (step.primitive) {
      case "navigate": {
        if (!step.path) throw new Error("Navigate step requires a path");
        const url = new URL(step.path, run.origin);
        if (
          url.origin !== run.origin ||
          !run.recipe.allowedOrigins.includes(url.origin)
        )
          throw new Error("Navigate step left the approved origin");
        await this.browser.open(url.href);
        return done;
      }
      case "click":
        await this.assertCurrent(step, run);
        await this.browser.click(requiredRef(step));
        return done;
      case "submit":
        if (!(await this.current(step, run)))
          return { stepId: step.id, outcome: "failed_before_submit" };
        await this.browser.click(requiredRef(step));
        return done;
      case "await-email-link": {
        const url = endpoint(await this.ports.mailbox.resetLink());
        if (!run.recipe.allowedOrigins.includes(url.origin))
          throw new Error("Mail link left the approved origins");
        await this.browser.open(url.href);
        return done;
      }
      case "fill-field":
        await this.assertCurrent(step, run);
        await this.fill(step, run);
        return done;
      case "verify-login":
        return (await this.ports.verifyLogin(run))
          ? done
          : { stepId: step.id, outcome: "reconcile" };
      default:
        throw new Error("Unsupported browser step");
    }
  }

  private async challenge(
    step: RecipeStep,
    run: ResetRun,
    attempt: number,
  ): Promise<StepReceipt> {
    const challenge =
      step.primitive === "enter-TOTP"
        ? "totp"
        : step.primitive === "enter-email-code"
          ? "mail_code"
          : step.primitive === "passkey-prompt"
            ? "passkey"
            : (detectChallenge(await this.browser.snapshot()) ?? "unknown");
    if (attempt > 1) {
      await this.ports.takeover.resume(challenge, run);
      if (detectChallenge(await this.browser.snapshot()) !== null)
        return { stepId: step.id, outcome: "waiting" };
      return { stepId: step.id, outcome: "completed" };
    }
    await this.ports.takeover.handoff(challenge, run);
    return { stepId: step.id, outcome: "waiting" };
  }

  private async current(step: RecipeStep, run: ResetRun): Promise<boolean> {
    const observation = await this.browser.snapshot();
    return observation.origin === run.origin && !stepDrift(step, observation);
  }

  private async assertCurrent(step: RecipeStep, run: ResetRun): Promise<void> {
    if (!(await this.current(step, run)))
      throw new Error("Recipe step drifted");
  }

  private async fill(step: RecipeStep, run: ResetRun): Promise<void> {
    if (step.purpose === "identifier") {
      await this.browser.fill(requiredRef(step), await this.ports.identifier());
      return;
    }
    if (step.purpose !== "new-password")
      throw new Error("Fill step has no approved purpose");
    const index = run.recipe.steps.findIndex(
      (candidate) => candidate.id === step.id,
    );
    const next = run.recipe.steps
      .slice(index + 1)
      .find(
        (candidate) =>
          candidate.primitive !== "fill-field" ||
          candidate.purpose !== "new-password",
      );
    if (index < 0 || next?.primitive !== "submit")
      throw new Error(
        "The real password may only be filled in the block before submit",
      );
    const proof = run.recipe.proxySubstitution;
    const proxy = this.ports.proxy;
    if (run.transport === "proxy") {
      if (!proof || !proxy)
        throw new Error("The approved proxy lane is unavailable");
      this.ports.authorizeProxy();
      assertProxyLane(true, proof);
      await this.ports.candidate.withSynthetic(proof, async (synthetic) => {
        await proxy.arm({
          run,
          proof,
          synthetic,
          withRealPassword: (use) => this.ports.candidate.withPassword(use),
        });
        await this.browser.fill(requiredRef(step), synthetic);
      });
      return;
    }
    await this.ports.candidate.withPassword((password) =>
      this.browser.fillSecret(requiredRef(step), password),
    );
  }
}

function requiredRef(step: RecipeStep): string {
  if (!step.ref) throw new Error("Browser step requires an element ref");
  return step.ref;
}

function endpoint(value: string): URL {
  const url = new URL(value);
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error("Browser URL must be a credential-free HTTP(S) URL");
  return url;
}
