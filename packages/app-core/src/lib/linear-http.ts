/** Linear transport: credentials only reach Linear's fixed API origin. */
import type { BoundaryValue, JsonObject } from "@opensesame/os-domain";
import { z } from "zod";

export const LINEAR_API_ORIGIN = "https://api.linear.app";
const MAX_REPLY_BYTES = 256 * 1024;
const TIMEOUT_MS = 15_000;

/** The owning capability binds its declared egress when it activates. */
type LinearApiTransport = { fetch: typeof fetch };
export const linearApiSeams: LinearApiTransport = {
  fetch: async () => {
    throw new LinearApiError("network");
  },
};

export type LinearCredential = {
  kind: "oauth" | "api-key";
  token: string;
};
export type LinearOAuthError = "invalid_grant" | "invalid_client";

export class LinearApiError extends Error {
  readonly name = "LinearApiError";
  constructor(
    readonly code:
      | "authorization"
      | "permission"
      | "rate-limit"
      | "response"
      | "network"
      | "input",
    readonly status = 0,
    readonly oauthError?: LinearOAuthError,
  ) {
    const messages = {
      authorization:
        "Linear authorization expired or was refused. Reconnect Linear.",
      permission:
        "Linear refused this operation. Check the account permissions and granted scopes.",
      "rate-limit": "Linear rate limited this request. Try again shortly.",
      response: "Linear did not complete the requested operation.",
      network: "Could not reach Linear. Check your connection and try again.",
      input: "Enter valid Linear operation details.",
    };
    super(messages[code]);
  }
}

export function linearInput<T>(schema: z.ZodType<T>, value: BoundaryValue): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new LinearApiError("input");
  return result.data;
}

export function linearOutput<T>(schema: z.ZodType<T>, value: BoundaryValue): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new LinearApiError("response");
  return result.data;
}

async function readReply(response: Response): Promise<BoundaryValue> {
  const reader = response.body?.getReader();
  if (!reader) throw new LinearApiError("response", response.status);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_REPLY_BYTES) throw new LinearApiError("response");
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const parsed: BoundaryValue = JSON.parse(new TextDecoder().decode(bytes));
    return parsed;
  } catch {
    throw new LinearApiError("response", response.status);
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function assertStatus(response: Response, oauthError?: LinearOAuthError): void {
  if (response.status === 401)
    throw new LinearApiError("authorization", 401, oauthError);
  if (response.status === 403) throw new LinearApiError("permission", 403);
  if (response.status === 429) throw new LinearApiError("rate-limit", 429);
  if (!response.ok)
    throw new LinearApiError("response", response.status, oauthError);
}

const OAuthErrorSchema = z.object({
  error: z.enum(["invalid_grant", "invalid_client"]),
});
async function oauthFailure(
  response: Response,
): Promise<LinearOAuthError | undefined> {
  try {
    const reply = await readReply(response);
    const parsed = OAuthErrorSchema.safeParse(reply);
    return parsed.success ? parsed.data.error : undefined;
  } catch {
    return undefined;
  }
}

/** The path is an internal closed set, never a form-supplied destination. */
export async function linearRequest(
  path: "/graphql" | "/oauth/token" | "/oauth/revoke",
  init: RequestInit,
  emptyReply = false,
): Promise<BoundaryValue> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await linearApiSeams.fetch(`${LINEAR_API_ORIGIN}${path}`, {
      ...init,
      method: "POST",
      mode: "cors",
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
      referrerPolicy: "no-referrer",
      signal: controller.signal,
    });
    const oauthError =
      path === "/oauth/token" && [400, 401].includes(response.status)
        ? await oauthFailure(response)
        : undefined;
    if (!response.ok) await response.body?.cancel().catch(() => undefined);
    assertStatus(response, oauthError);
    if (emptyReply) {
      await response.body?.cancel().catch(() => undefined);
      return null;
    }
    return await readReply(response);
  } catch (error) {
    if (error instanceof LinearApiError) throw error;
    throw new LinearApiError("network");
  } finally {
    clearTimeout(timeout);
  }
}

const CredentialSchema = z.object({
  kind: z.enum(["oauth", "api-key"]),
  token: z
    .string()
    .min(1)
    .max(16_384)
    .regex(/^[!-~]+$/),
});
const EnvelopeSchema = z.object({
  data: z.record(z.string(), z.json()).nullable().optional(),
  errors: z
    .array(
      z.object({
        extensions: z.object({ code: z.string().optional() }).optional(),
      }),
    )
    .optional(),
});

export async function linearGraphql<T>(
  credential: LinearCredential,
  query: string,
  variables: JsonObject,
  schema: z.ZodType<T>,
): Promise<T> {
  const checked = linearInput(CredentialSchema, credential);
  const reply = await linearRequest("/graphql", {
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      Authorization:
        checked.kind === "oauth" ? `Bearer ${checked.token}` : checked.token,
    },
    body: JSON.stringify({ query, variables }),
  });
  const envelope = linearOutput(EnvelopeSchema, reply);
  if (envelope.errors?.length) {
    const codes = envelope.errors.map((error) => error.extensions?.code);
    if (codes.includes("AUTHENTICATION_ERROR"))
      throw new LinearApiError("authorization");
    if (codes.includes("FORBIDDEN")) throw new LinearApiError("permission");
    throw new LinearApiError("response");
  }
  return linearOutput(schema, envelope.data ?? null);
}
