import { randomBytes } from "node:crypto";
import {
  type JsonObject,
  type JsonValue,
  isJsonObject,
  isString,
  readString,
} from "@opensesame/os-domain";

/**
 * RFC 7591 dynamic client registration.
 *
 * Registrations are held in process memory for the lifetime of the server —
 * a real registry with a real lifecycle, just one that is not asked to survive
 * a restart. Registered clients authenticate with `client_secret_post` and are
 * accepted by the same `/authorize` + `/token` code path as the seeded client.
 */

export interface RegisteredClient {
  clientId: string;
  clientSecret: string;
  redirectUris: string[];
  clientName?: string;
  issuedAt: number;
}

export type ClientRegistry = Map<string, RegisteredClient>;

export interface RegistrationOutcome {
  status: number;
  body: JsonObject;
}

const SUPPORTED_AUTH_METHODS = ["client_secret_post", "client_secret_basic"];

function parseJsonBody(raw: string): JsonObject | undefined {
  try {
    const parsed: JsonValue = JSON.parse(raw);
    return isJsonObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function readRedirectUris(value: JsonValue | undefined): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const uris: string[] = [];
  for (const entry of value) {
    if (!isString(entry)) return undefined;
    let parsed: URL;
    try {
      parsed = new URL(entry);
    } catch {
      return undefined;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return undefined;
    }
    if (parsed.hash.length > 0) return undefined;
    uris.push(entry);
  }
  return uris;
}

export function registerClient(
  registry: ClientRegistry,
  rawBody: string,
): RegistrationOutcome {
  const metadata = parseJsonBody(rawBody);
  if (!metadata) {
    return {
      status: 400,
      body: {
        error: "invalid_client_metadata",
        error_description: "registration body must be a JSON object",
      },
    };
  }

  const redirectUris = readRedirectUris(metadata.redirect_uris);
  if (!redirectUris) {
    return {
      status: 400,
      body: {
        error: "invalid_redirect_uri",
        error_description:
          "redirect_uris must be a non-empty array of absolute http(s) URIs without a fragment",
      },
    };
  }

  const authMethod =
    readString(metadata.token_endpoint_auth_method) ?? "client_secret_post";
  if (!SUPPORTED_AUTH_METHODS.includes(authMethod)) {
    return {
      status: 400,
      body: {
        error: "invalid_client_metadata",
        error_description: `token_endpoint_auth_method must be one of ${SUPPORTED_AUTH_METHODS.join(", ")}`,
      },
    };
  }

  const clientName = readString(metadata.client_name);
  const record: RegisteredClient = {
    clientId: `dcr-${randomBytes(12).toString("hex")}`,
    clientSecret: randomBytes(32).toString("base64url"),
    redirectUris,
    issuedAt: Math.floor(Date.now() / 1000),
    ...(clientName !== undefined ? { clientName } : undefined),
  };
  registry.set(record.clientId, record);

  return {
    status: 201,
    body: {
      client_id: record.clientId,
      client_secret: record.clientSecret,
      client_id_issued_at: record.issuedAt,
      client_secret_expires_at: 0,
      redirect_uris: record.redirectUris,
      token_endpoint_auth_method: "client_secret_post",
      grant_types: ["authorization_code"],
      response_types: ["code"],
      ...(record.clientName !== undefined
        ? { client_name: record.clientName }
        : undefined),
    },
  };
}
