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
import { requestBoatDeletion, waitForBoatDeletion } from "./boat-deletion.js";
import { boatCheckoutUrl, boatOrigin } from "./boat-endpoints.js";
import { boatApiError } from "./boat-error.js";
export { BoatApiError } from "./boat-error.js";
export {
  BoatDeletionPendingError,
  BoatDeletionUnconfirmedError,
} from "./boat-deletion.js";

export interface BoatClientOptions {
  /** Boat origin; staging and self-hosted control planes differ. */
  origin?: string;
  fetchImpl?: typeof fetch;
  /** Maximum time to wait for Boat's asynchronous data deletion. */
  deletionTimeoutMs?: number;
  deletionRequestTimeoutMs?: number;
  deletionPollIntervalMs?: number;
}

export interface BoatSandbox {
  id: string;
  state: string;
  url?: string | null | undefined;
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
  url: z.string().nullable().optional(),
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
  port: z.number().int(),
  isProtected: z.literal(true),
  access: z.literal("private"),
});

interface RequestOptions {
  method: string;
  path: string;
  accessToken: string;
  body?: CreateSandboxBody | CommandBody | HostPortBody;
  idempotencyKey?: string;
  signal?: AbortSignal;
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
  "x-ascii-confirm-delete"?: string;
};

export interface RunCommandOptions {
  timeoutSeconds?: number;
}

export class BoatClient {
  private readonly origin: string;
  private readonly fetchImpl: typeof fetch;
  private readonly deletionTimeoutMs: number;
  private readonly deletionRequestTimeoutMs: number;
  private readonly deletionPollIntervalMs: number;

  constructor(options: BoatClientOptions = {}) {
    this.origin = boatOrigin(options.origin ?? "https://boat.dev");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.deletionTimeoutMs = options.deletionTimeoutMs ?? 30_000;
    this.deletionRequestTimeoutMs = options.deletionRequestTimeoutMs ?? 10_000;
    this.deletionPollIntervalMs = options.deletionPollIntervalMs ?? 1_000;
    if (
      !Number.isInteger(this.deletionTimeoutMs) ||
      this.deletionTimeoutMs < 0 ||
      this.deletionTimeoutMs > 86_400_000 ||
      !Number.isInteger(this.deletionRequestTimeoutMs) ||
      this.deletionRequestTimeoutMs < 1 ||
      this.deletionRequestTimeoutMs > 86_400_000 ||
      !Number.isInteger(this.deletionPollIntervalMs) ||
      this.deletionPollIntervalMs < 1 ||
      this.deletionPollIntervalMs > 86_400_000
    )
      throw new Error("boat: invalid deletion polling settings");
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
    if (options.method === "DELETE") {
      const id = options.path.split("/").at(-1) ?? "";
      if (!/^bx_[23456789abcdefghjkmnpqrstuvwxyz]{8}$/u.test(id))
        throw new Error("boat: invalid sandbox id");
      headers["x-ascii-confirm-delete"] = id;
    }
    const init: RequestInit = {
      method: options.method,
      headers,
      redirect: "error",
    };
    if (options.signal) init.signal = options.signal;
    if (options.body !== undefined) init.body = JSON.stringify(options.body);
    const response = await this.fetchImpl(
      `${this.origin}/api/v1${options.path}`,
      init,
    );
    const raw = boatJsonValueSchema.parse(
      await response.json().catch(() => null),
    );
    if (!response.ok) throw boatApiError(raw, response.status);
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
    const sandbox = getSandboxResponseSchema.parse(raw).sandbox;
    if (sandbox.id !== sandboxId)
      throw new Error("boat: sandbox identity mismatch");
    return sandbox;
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
    const hosted = hostPortResponseSchema.parse(raw);
    if (hosted.port !== port) throw new Error("boat: hosted port mismatch");
    return hosted.url;
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
        redirect: "error",
      },
    );
    if (!response.ok)
      throw new Error(
        `boat: checkout request failed (HTTP ${response.status})`,
      );
    return boatCheckoutUrl(
      checkoutResponseSchema.parse(await response.json()).url,
      this.origin,
    );
  }

  async deleteSandbox(accessToken: string, sandboxId: string): Promise<void> {
    const accepted = await requestBoatDeletion(
      sandboxId,
      this.deletionRequestTimeoutMs,
      (signal) =>
        this.request({
          method: "DELETE",
          path: `/sandboxes/${encodeURIComponent(sandboxId)}`,
          accessToken,
          signal,
        }),
    );
    if (accepted.status === "completed") return;
    await this.waitForDeletion(accessToken, sandboxId, accepted.id);
  }

  /** Resume checking an accepted deletion after BoatDeletionPendingError. */
  async waitForDeletion(
    accessToken: string,
    sandboxId: string,
    operationId: string,
  ): Promise<void> {
    await waitForBoatDeletion(
      sandboxId,
      operationId,
      this.deletionTimeoutMs,
      this.deletionPollIntervalMs,
      (id, signal) =>
        this.request({
          method: "GET",
          path: `/deletion-operations/${id}`,
          accessToken,
          signal,
        }),
    );
  }
}
