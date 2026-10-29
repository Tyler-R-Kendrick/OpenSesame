/**
 * Boat REST client: sandbox lifecycle, commands, and port hosting.
 *
 * API shape: https://docs.boat.dev/api/v1 (base `https://boat.dev/api/v1`,
 * bearer auth, `{ ok, type, ... }` envelopes). Commands and their
 * output are kept in Boat's command history, so callers must never put a
 * site secret in a command string — this client only ever sends the
 * operator-configured agent start command.
 */

import { z } from "zod";

export interface BoatClientOptions {
  /** Boat origin; staging and self-hosted control planes differ. */
  origin?: string;
  fetchImpl?: typeof fetch;
}

export interface BoatSandbox {
  id: string;
  state: string;
}

export interface CreateSandboxInput {
  ttlSeconds?: number;
  /** Saved snapshot to start from (e.g. one with the relay agent installed). */
  from?: string;
  labels?: Readonly<Record<string, string>>;
  env?: Readonly<Record<string, string>>;
}

export interface BoatCommandResult {
  success: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export interface BoatCommandStarted {
  processId: number;
}

/** Any JSON value; the response contract before per-endpoint parsing. */
export type BoatJsonValue =
  | string
  | number
  | boolean
  | null
  | BoatJsonValue[]
  | { [key: string]: BoatJsonValue };

const boatJsonValueSchema: z.ZodType<BoatJsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(boatJsonValueSchema),
    z.record(z.string(), boatJsonValueSchema),
  ]),
);

const sandboxSchema = z.object({
  id: z.string(),
  state: z.string(),
});

const createSandboxResponseSchema = z.object({
  ok: z.literal(true),
  sandbox: sandboxSchema,
});

const getSandboxResponseSchema = z.object({
  ok: z.literal(true),
  sandbox: sandboxSchema,
});

const commandResponseSchema = z.object({
  ok: z.literal(true),
  type: z.literal("command.finished"),
  success: z.boolean(),
  exitCode: z.number().nullable(),
  stdout: z.string(),
  stderr: z.string(),
});

const commandStartedResponseSchema = z.object({
  ok: z.literal(true),
  type: z.literal("command.started"),
  success: z.boolean(),
  processId: z.number(),
});

const checkoutResponseSchema = z.object({ url: z.string() });

const hostPortResponseSchema = z.object({
  ok: z.literal(true),
  url: z.string(),
});

const errorEnvelopeSchema = z.object({
  ok: z.literal(false),
  code: z.string().optional(),
  message: z.string().optional(),
  error: z
    .object({
      code: z.string().optional(),
      message: z.string().optional(),
    })
    .optional(),
});

/** A Boat API error with its stable machine-readable code. */
export class BoatApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(input: { code: string; status: number; message: string }) {
    super(`boat: ${input.message} (${input.code})`);
    this.name = "BoatApiError";
    this.code = input.code;
    this.status = input.status;
  }
}

interface RequestOptions {
  method: string;
  path: string;
  accessToken: string;
  body?: CreateSandboxBody | CommandBody | HostPortBody;
  idempotencyKey?: string;
}

interface CreateSandboxBody {
  ttlSeconds: number;
  type: "small";
  noEnv: boolean;
  monitoring: boolean;
  snapshots: boolean;
  from?: string;
  labels?: Readonly<Record<string, string>>;
  env?: Readonly<Record<string, string>>;
}

interface CommandBody {
  command: string;
  detached?: boolean;
  timeoutSeconds?: number;
}

interface HostPortBody {
  port: number;
  localhost: boolean;
}

type BoatRequestHeaders = {
  authorization: string;
  "content-type": string;
  "idempotency-key"?: string;
};

export interface RunCommandOptions {
  timeoutSeconds?: number;
}

export class BoatClient {
  private readonly origin: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: BoatClientOptions = {}) {
    this.origin = (options.origin ?? "https://boat.dev").replace(/\/$/u, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  get apiOrigin(): string {
    return this.origin;
  }

  private async request(options: RequestOptions): Promise<BoatJsonValue> {
    const headers: BoatRequestHeaders = {
      authorization: `Bearer ${options.accessToken}`,
      "content-type": "application/json",
    };
    if (options.idempotencyKey)
      headers["idempotency-key"] = options.idempotencyKey;
    const init: RequestInit = { method: options.method, headers };
    if (options.body !== undefined) init.body = JSON.stringify(options.body);
    const response = await this.fetchImpl(
      `${this.origin}/api/v1${options.path}`,
      init,
    );
    const raw = boatJsonValueSchema.parse(
      await response.json().catch(() => null),
    );
    if (!response.ok) {
      const parsed = errorEnvelopeSchema.safeParse(raw);
      const code =
        (parsed.success
          ? (parsed.data.code ?? parsed.data.error?.code)
          : undefined) ?? `http_${response.status}`;
      const message =
        (parsed.success
          ? (parsed.data.message ?? parsed.data.error?.message)
          : undefined) ?? `HTTP ${response.status}`;
      throw new BoatApiError({ code, status: response.status, message });
    }
    return raw;
  }

  async createSandbox(
    accessToken: string,
    input: CreateSandboxInput = {},
  ): Promise<BoatSandbox> {
    // An agent sandbox for one run: none of the account's secrets, no
    // retained command output, no snapshot to resurrect cookies from.
    const body: CreateSandboxBody = {
      ttlSeconds: input.ttlSeconds ?? 3600,
      type: "small",
      noEnv: true,
      monitoring: false,
      snapshots: false,
    };
    if (input.from) body.from = input.from;
    if (input.labels) body.labels = input.labels;
    if (input.env) body.env = input.env;
    const raw = await this.request({
      method: "POST",
      path: "/sandboxes",
      accessToken,
      body,
      idempotencyKey: crypto.randomUUID(),
    });
    return createSandboxResponseSchema.parse(raw).sandbox;
  }

  async getSandbox(
    accessToken: string,
    sandboxId: string,
  ): Promise<BoatSandbox> {
    const raw = await this.request({
      method: "GET",
      path: `/sandboxes/${encodeURIComponent(sandboxId)}`,
      accessToken,
    });
    return getSandboxResponseSchema.parse(raw).sandbox;
  }

  async resumeSandbox(accessToken: string, sandboxId: string): Promise<void> {
    await this.request({
      method: "POST",
      path: `/sandboxes/${encodeURIComponent(sandboxId)}/resume`,
      accessToken,
    });
  }

  async runCommand(
    accessToken: string,
    sandboxId: string,
    command: string,
    options: RunCommandOptions = {},
  ): Promise<BoatCommandResult> {
    const body: CommandBody = { command };
    if (options.timeoutSeconds !== undefined)
      body.timeoutSeconds = options.timeoutSeconds;
    const raw = await this.request({
      method: "POST",
      path: `/sandboxes/${encodeURIComponent(sandboxId)}/commands`,
      accessToken,
      body,
    });
    const parsed = commandResponseSchema.parse(raw);
    return {
      success: parsed.success,
      exitCode: parsed.exitCode,
      stdout: parsed.stdout,
      stderr: parsed.stderr,
    };
  }

  async startDetachedCommand(
    accessToken: string,
    sandboxId: string,
    command: string,
  ): Promise<BoatCommandStarted> {
    const raw = await this.request({
      method: "POST",
      path: `/sandboxes/${encodeURIComponent(sandboxId)}/commands`,
      accessToken,
      body: { command, detached: true },
    });
    const parsed = commandStartedResponseSchema.parse(raw);
    return { processId: parsed.processId };
  }

  /** Expose a sandbox port; returns the token-gated HTTPS URL. */
  async hostPort(
    accessToken: string,
    sandboxId: string,
    port: number,
  ): Promise<string> {
    const raw = await this.request({
      method: "POST",
      path: `/sandboxes/${encodeURIComponent(sandboxId)}/host`,
      accessToken,
      body: { port, localhost: true },
    });
    return hostPortResponseSchema.parse(raw).url;
  }

  async stopSandbox(accessToken: string, sandboxId: string): Promise<void> {
    await this.request({
      method: "POST",
      path: `/sandboxes/${encodeURIComponent(sandboxId)}/stop`,
      accessToken,
    });
  }

  /**
   * Start Boat's billing checkout (auth.md Step 7) and return the URL a
   * person opens to put a card on file. Lives outside `/api/v1`.
   */
  async createCheckout(accessToken: string): Promise<string> {
    const response = await this.fetchImpl(
      `${this.origin}/api/boat/billing/checkout`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ kind: "subscription" }),
      },
    );
    if (!response.ok)
      throw new Error(
        `boat: checkout request failed (HTTP ${response.status})`,
      );
    return checkoutResponseSchema.parse(await response.json()).url;
  }

  async deleteSandbox(accessToken: string, sandboxId: string): Promise<void> {
    await this.request({
      method: "DELETE",
      path: `/sandboxes/${encodeURIComponent(sandboxId)}`,
      accessToken,
    });
  }
}
