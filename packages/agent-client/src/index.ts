import { registerAgentSecret } from "@opensesame/observability";
import { z } from "zod";
import { exchangeOnSocket } from "./uds.js";

const grantSchema = z
  .object({
    access_token: z.string().regex(/^agent-capability:[0-9a-f]{64}$/),
    token_type: z.literal("Bearer"),
    expires_in: z.number().int().min(1).max(300),
    client_id: z.string().uuid(),
    audience: z.enum([
      "urn:opensesame:agent:mcp-host",
      "urn:opensesame:agent:mcp-client",
    ]),
    scope: z.array(z.string().min(1).max(128)).min(1).max(16),
  })
  .strict();

export type AgentAudience = z.infer<typeof grantSchema>["audience"];
export type AgentHeaders = {
  authorization: string;
  "x-opensesame-agent-client": string;
  "x-opensesame-agent-audience": AgentAudience;
};
type Grant = z.infer<typeof grantSchema> & {
  expiresAt: number;
  resource: string;
};

/** A process-local, one-use acquisition. It never reads an operator/session token. */
export class AgentClient {
  private grant: Grant | undefined;
  private acquisition: Promise<Grant> | undefined;
  private attempted = false;
  private generation = 0;

  constructor(
    private readonly audience: AgentAudience,
    private readonly fetcher: typeof fetch = fetch,
    private readonly socketExchange: typeof exchangeOnSocket = exchangeOnSocket,
  ) {}

  async headers(resource: string): Promise<AgentHeaders> {
    const normalized = exactResource(resource);
    if (!this.grant) {
      const generation = this.generation;
      this.acquisition ??= this.acquire(normalized);
      const grant = await this.acquisition;
      if (generation !== this.generation)
        throw new Error("agent capability acquisition cancelled");
      this.grant = grant;
    }
    if (
      this.grant.resource !== normalized ||
      this.grant.expiresAt <= Date.now()
    )
      throw new Error("agent capability expired or audience mismatch");
    return {
      authorization: `Bearer ${this.grant.access_token}`,
      "x-opensesame-agent-client": this.grant.client_id,
      "x-opensesame-agent-audience": this.audience,
    };
  }

  forget(): void {
    this.generation++;
    this.grant = undefined;
    this.acquisition = undefined;
  }

  private async acquire(resource: string): Promise<Grant> {
    if (this.attempted)
      throw new Error("a new approved agent launch is required");
    this.attempted = true;
    const handle = process.env.OPENSESAME_AGENT_LAUNCH_HANDLE;
    const client = process.env.OPENSESAME_AGENT_CLIENT_ID;
    Reflect.deleteProperty(process.env, "OPENSESAME_AGENT_LAUNCH_HANDLE");
    if (
      !handle ||
      !/^[0-9a-f]{64}$/.test(handle) ||
      !z.string().uuid().safeParse(client).success
    )
      throw new Error(
        "an approved agent launch handle and client id are required",
      );
    registerAgentSecret(handle, Date.now() + 300_000);
    const body = JSON.stringify({
      launch_handle: handle,
      client_id: client,
      audience: this.audience,
    });
    let text: string;
    try {
      if (process.platform === "win32")
        text = await this.exchangeWindows(resource, body);
      else {
        const socket = process.env.OPENSESAME_AGENT_SOCK;
        if (!socket) throw new Error("agent socket required");
        text = await this.socketExchange(socket, body);
      }
    } catch {
      throw new Error("agent launch exchange failed");
    }
    const parsed = parseResponse(text);
    if (
      !parsed.success ||
      parsed.data.client_id !== client ||
      parsed.data.audience !== this.audience
    )
      throw new Error("agent launch binding mismatch");
    registerAgentSecret(
      parsed.data.access_token.slice("agent-capability:".length),
      Date.now() + parsed.data.expires_in * 1000,
    );
    return {
      ...parsed.data,
      expiresAt: Date.now() + parsed.data.expires_in * 1000,
      resource,
    };
  }

  private async exchangeWindows(
    resource: string,
    body: string,
  ): Promise<string> {
    const response = await this.fetcher(
      `${resource}/api/v1/agent-launches/token`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        redirect: "error",
        credentials: "omit",
        signal: AbortSignal.timeout(5000),
      },
    );
    if (!response.ok || !response.body) throw new Error("agent launch refused");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const result = await reader.read();
        if (result.done) break;
        size += result.value.byteLength;
        if (size > 8192) throw new Error("agent response too large");
        chunks.push(result.value);
      }
      return Buffer.concat(chunks).toString("utf8");
    } finally {
      await reader.cancel();
    }
  }
}

export function exactResource(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("invalid agent Host resource");
  }
  const local =
    url.hostname === "localhost" ||
    url.hostname === "[::1]" ||
    /^127(?:\.[0-9]{1,3}){3}$/.test(url.hostname);
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && local)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    (raw !== url.origin && raw !== `${url.origin}/`)
  )
    throw new Error(
      "agent Host resource must be an exact HTTPS or loopback origin",
    );
  return url.origin;
}

function parseResponse(text: string): ReturnType<typeof grantSchema.safeParse> {
  try {
    return grantSchema.safeParse(JSON.parse(text));
  } catch {
    throw new Error("invalid agent launch response");
  }
}
