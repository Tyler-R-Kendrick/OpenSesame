import {
  type ChildProcessByStdio,
  type SpawnOptions,
  spawn,
} from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Readable, Writable } from "node:stream";
import { z } from "zod";
import { type Observation, observationSchema } from "./types.js";

export * from "./browser-step-executor.js";

export interface BrowserDriver {
  open(url: string): Promise<void>;
  snapshot(): Promise<Observation>;
  click(ref: string): Promise<void>;
  fill(ref: string, value: string): Promise<void>;
  fillSecret(ref: string, value: string): Promise<void>;
  pageUrl?(): Promise<string>;
  close?(): Promise<void>;
}

type Spawn = (
  command: string,
  args: string[],
  options: SpawnOptions & { stdio: ["pipe", "pipe", "pipe"] },
) => ChildProcessByStdio<Writable, Readable, Readable>;

export interface AgentBrowserConfig {
  executable: string;
  session: string;
  allowedDomains: readonly string[];
  browserExecutable?: string;
  timeoutMs?: number;
  spawn?: Spawn;
  /**
   * Optional override. Default: `agent-browser batch` commands on stdin, so
   * the secret never appears in process argv, logs, or the run journal.
   */
  secretFill?(ref: string, value: string): Promise<void>;
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
    data: z.union([
      z.string().transform((url) => ({ url })),
      z.object({ url: z.string() }).passthrough(),
    ]),
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

const CHALLENGE_TEXT =
  /captcha|verify you are human|one.time code|mail_code|text message|passkey|security key|two.factor|2fa|authenticator|totp/iu;

function challengePhrase(snapshot: string): string | null {
  if (/captcha|verify you are human/iu.test(snapshot))
    return "CAPTCHA verify you are human";
  if (/passkey|security key/iu.test(snapshot))
    return "Passkey security key required";
  if (/text message/iu.test(snapshot)) return "Text message code required";
  if (/authenticator|totp/iu.test(snapshot))
    return "Authenticator TOTP code required";
  if (/one.time code|code from email|email code/iu.test(snapshot))
    return "One-time code from email";
  return null;
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
  // Challenge copy is usually static text: it appears in the snapshot
  // string but never gets an interactive ref, so without this the run
  // could not tell a person is needed. Surface only the canonical phrase
  // (never page text) on a synthetic, non-actionable ref.
  const challenge = challengePhrase(raw.data.snapshot);
  if (
    challenge &&
    !fields.some((field) => CHALLENGE_TEXT.test(field.label)) &&
    fields.length < 100
  ) {
    const maxRef = fields.reduce(
      (max, field) => Math.max(max, Number(field.ref.slice(1))),
      0,
    );
    fields.push({ ref: `e${maxRef + 1}`, kind: "static", label: challenge });
  }
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
    this.command =
      config.spawn ??
      ((command, args, options) => spawn(command, args, options));
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
    // Full (not -i) snapshot: refs are the same, but the snapshot text
    // carries static copy — where challenge prompts live.
    const output = await this.run(["snapshot", "--json"]);
    return parseAgentBrowserSnapshot(output, current.origin);
  }

  async click(ref: string): Promise<void> {
    await this.run(["click", elementRef(ref)]);
    // A form submit click returns before the POST/navigation settles; the
    // next step (or candidate verification) must not race the server.
    await this.run(["wait", "--load", "load"]);
  }

  async fill(ref: string, value: string): Promise<void> {
    if (value.length > 4096) throw new Error("Browser fill exceeds its bound");
    await this.run(["fill", elementRef(ref), value]);
  }

  get sessionName(): string {
    return this.config.session;
  }

  async fillSecret(ref: string, value: string): Promise<void> {
    const target = elementRef(ref);
    if (this.config.secretFill) return this.config.secretFill(target, value);
    if (value.length > 4096) throw new Error("Browser fill exceeds its bound");
    const output = await this.run(
      ["batch", "--bail", "--json"],
      JSON.stringify([["fill", target, value]]),
    );
    assertBatchSucceeded(output);
  }

  async pageUrl(): Promise<string> {
    return this.currentUrl();
  }

  async close(): Promise<void> {
    await this.run(["close"]);
  }

  private async currentUrl(): Promise<string> {
    const result = urlResultSchema.parse(
      JSON.parse(await this.run(["get", "url", "--json"])),
    );
    return result.data.url;
  }

  private run(args: string[], stdin?: string): Promise<string> {
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
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      child.stdin.on("error", () => {});
      if (stdin !== undefined) child.stdin.end(stdin);
      else child.stdin.end();
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

const batchResultSchema = z.array(
  z.object({ success: z.boolean() }).passthrough(),
);

function assertBatchSucceeded(output: string): void {
  try {
    const results = batchResultSchema.parse(JSON.parse(output));
    if (results.length === 0 || results.some((r) => !r.success))
      throw new Error("failed");
  } catch {
    throw new Error("agent-browser command failed");
  }
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
