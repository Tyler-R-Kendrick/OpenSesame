import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { detectChallenge } from "./decisions.js";
import { stepDrift } from "./recipe.js";
import { type CandidateCustody, assertProxyLane } from "./secrets.js";
import {
  type HumanChallenge,
  type Observation,
  type ProxyProof,
  type RecipeStep,
  type ResetRun,
  type StepReceipt,
  observationSchema,
} from "./types.js";

export interface BrowserDriver {
  open(url: string): Promise<void>;
  snapshot(): Promise<Observation>;
  click(ref: string): Promise<void>;
  fill(ref: string, value: string): Promise<void>;
  fillSecret(ref: string, value: string): Promise<void>;
  close?(): Promise<void>;
}

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

type Spawn = typeof spawn;

export interface AgentBrowserConfig {
  executable: string;
  session: string;
  allowedDomains: readonly string[];
  browserExecutable?: string;
  timeoutMs?: number;
  spawn?: Spawn;
  secretFill(ref: string, value: string): Promise<void>;
}

const rawSnapshotSchema = z
  .object({
    success: z.literal(true),
    data: z
      .object({
        snapshot: z.string(),
        refs: z.record(
          z.string(),
          z
            .object({
              role: z.string(),
              name: z.string(),
            })
            .passthrough(),
        ),
      })
      .passthrough(),
  })
  .passthrough();
const urlResultSchema = z
  .object({
    success: z.literal(true),
    data: z.union([z.string(), z.object({ url: z.string() }).passthrough()]),
  })
  .passthrough();

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

export function parseAgentBrowserSnapshot(
  output: string,
  origin: string,
): Observation {
  let raw: z.infer<typeof rawSnapshotSchema>;
  try {
    raw = rawSnapshotSchema.parse(JSON.parse(output));
  } catch {
    throw new Error("agent-browser returned an invalid snapshot");
  }
  const fields = Object.entries(raw.data.refs)
    .flatMap(([ref, value]) => {
      if (!/^e[1-9][0-9]*$/.test(ref))
        throw new Error("agent-browser returned an invalid ref");
      const kind = fieldKind(value.role, value.name);
      return kind ? [{ ref, kind, label: value.name.slice(0, 200) }] : [];
    })
    .slice(0, 100);
  return observationSchema.parse({ id: randomUUID(), origin, fields });
}

export class AgentBrowser implements BrowserDriver {
  private readonly command: Spawn;
  private readonly timeoutMs: number;

  constructor(private readonly config: AgentBrowserConfig) {
    if (
      !config.executable.trim() ||
      !config.session.trim() ||
      config.allowedDomains.length === 0
    )
      throw new Error(
        "agent-browser requires an executable, session and domain allowlist",
      );
    this.command = config.spawn ?? spawn;
    this.timeoutMs = config.timeoutMs ?? 30_000;
    if (
      !Number.isInteger(this.timeoutMs) ||
      this.timeoutMs < 1 ||
      this.timeoutMs > 120_000
    )
      throw new Error("Browser timeout is outside its bounds");
  }

  async open(url: string): Promise<void> {
    const target = endpoint(url);
    if (!this.config.allowedDomains.includes(target.hostname))
      throw new Error("Browser navigation left the approved domains");
    await this.run(["open", target.href]);
  }

  async snapshot(): Promise<Observation> {
    const current = endpoint(await this.currentUrl());
    if (!this.config.allowedDomains.includes(current.hostname))
      throw new Error("Browser page left the approved domains");
    const output = await this.run(["snapshot", "-i", "--json"]);
    return parseAgentBrowserSnapshot(output, current.origin);
  }

  async click(ref: string): Promise<void> {
    await this.run(["click", elementRef(ref)]);
  }

  async fill(ref: string, value: string): Promise<void> {
    if (value.length > 4096) throw new Error("Browser fill exceeds its bound");
    await this.run(["fill", elementRef(ref), value]);
  }

  fillSecret(ref: string, value: string): Promise<void> {
    return this.config.secretFill(elementRef(ref), value);
  }

  async close(): Promise<void> {
    await this.run(["close"]);
  }

  private async currentUrl(): Promise<string> {
    const result = urlResultSchema.parse(
      JSON.parse(await this.run(["get", "url", "--json"])),
    );
    return typeof result.data === "string" ? result.data : result.data.url;
  }

  private run(args: string[]): Promise<string> {
    const globals = [
      "--session",
      this.config.session,
      "--allowed-domains",
      this.config.allowedDomains.join(","),
      "--max-output",
      "1000000",
      "--no-webmcp",
      ...(this.config.browserExecutable
        ? ["--executable-path", this.config.browserExecutable]
        : []),
    ];
    return new Promise((resolve, reject) => {
      const child = this.command(
        this.config.executable,
        [...globals, ...args],
        {
          shell: false,
          env: { HOME: process.env.HOME ?? "", PATH: process.env.PATH ?? "" },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let stdout = "";
      let settled = false;
      const finish = (error?: Error, output = "") => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(output);
      };
      const timer = setTimeout(() => {
        child.kill();
        finish(new Error("agent-browser command timed out"));
      }, this.timeoutMs);
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
        if (stdout.length > 1_000_000) {
          child.kill();
          finish(new Error("agent-browser output exceeded its bound"));
        }
      });
      child.stderr.resume();
      child.on("error", () =>
        finish(new Error("agent-browser command failed")),
      );
      child.on("close", (code) =>
        code === 0
          ? finish(undefined, stdout)
          : finish(new Error("agent-browser command failed")),
      );
    });
  }
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
        await this.assertCurrent(step);
        await this.browser.click(requiredRef(step));
        return done;
      case "submit":
        if (!(await this.current(step)))
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
        await this.assertCurrent(step);
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

  private async current(step: RecipeStep): Promise<boolean> {
    return !stepDrift(step, await this.browser.snapshot());
  }

  private async assertCurrent(step: RecipeStep): Promise<void> {
    if (!(await this.current(step))) throw new Error("Recipe step drifted");
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
    if (index < 0 || run.recipe.steps[index + 1]?.primitive !== "submit")
      throw new Error(
        "The real password may only be filled immediately before submit",
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

function elementRef(ref: string): string {
  if (!/^e[1-9][0-9]*$/.test(ref))
    throw new Error("Invalid agent-browser element ref");
  return `@${ref}`;
}

function fieldKind(
  role: string,
  name: string,
): Observation["fields"][number]["kind"] | null {
  if (role === "button" || role === "link") return role;
  if (role !== "textbox") return null;
  if (/password/iu.test(name)) return "password";
  if (/totp|authenticator|one.time code|verification code/iu.test(name))
    return "otp";
  if (/email/iu.test(name)) return "email";
  return "text";
}
