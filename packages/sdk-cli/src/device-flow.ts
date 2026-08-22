import {
  type BoundaryValue,
  type JsonObject,
  type JsonValue,
  isJsonObject,
  isNumber,
  isString,
  isTypeofObject,
} from "@opensesame/os-domain";
import { encodeQrTerminal } from "@opensesame/qr";
import {
  assertDiscoveredUrl,
  assertDiscoveryBelongsToIssuer,
  assertSecureUrl,
  trimSlash,
} from "./secure-url.js";

export interface DeviceAuthorizationResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval?: number;
}

export interface TokenSuccess {
  access_token: string;
  token_type: string;
  expires_in?: number;
  refresh_token?: string;
  id_token?: string;
  scope?: string;
}

export type DevicePollResult =
  | { status: "success"; tokens: TokenSuccess }
  | { status: "authorization_pending"; intervalSeconds: number }
  | { status: "slow_down"; intervalSeconds: number }
  | { status: "access_denied" }
  | { status: "expired_token" }
  | { status: "error"; error: string; description?: string };

/** A server may ask the client to slow down; it may not ask it to stop polling. */
const MAX_POLL_INTERVAL_SECONDS = 60;

export interface DeviceFlowClientConfig {
  issuer: string;
  clientId: string;
  scopes?: string[];
  fetchImpl?: typeof fetch;
  /** Sleep helper (injectable for tests). */
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
}

export interface SafeDeviceStart {
  /** Never includes device_code — safe for logs/UI. */
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresIn: number;
  intervalSeconds: number;
}

async function defaultSleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

function parseJsonObject(value: BoundaryValue, label: string): JsonObject {
  if (!isJsonObject(value)) throw new Error(`${label} response was invalid`);
  return value;
}

function parseDeviceAuthorizationResponse(
  value: BoundaryValue,
): DeviceAuthorizationResponse {
  const data = parseJsonObject(value, "device authorization");
  if (
    !isString(data.device_code) ||
    !isString(data.user_code) ||
    !isString(data.verification_uri) ||
    !isNumber(data.expires_in) ||
    !Number.isFinite(data.expires_in) ||
    data.expires_in < 0 ||
    (data.verification_uri_complete !== undefined &&
      !isString(data.verification_uri_complete)) ||
    (data.interval !== undefined && !isNumber(data.interval))
  ) {
    throw new Error("device authorization response was invalid");
  }
  return {
    device_code: data.device_code,
    user_code: data.user_code,
    verification_uri: data.verification_uri,
    expires_in: data.expires_in,
    ...(data.verification_uri_complete === undefined
      ? undefined
      : { verification_uri_complete: data.verification_uri_complete }),
    ...(data.interval === undefined ? undefined : { interval: data.interval }),
  };
}

function parseTokenSuccess(value: JsonObject): TokenSuccess | undefined {
  if (!isString(value.access_token) || !isString(value.token_type)) {
    return undefined;
  }
  if (
    (value.expires_in !== undefined && !isNumber(value.expires_in)) ||
    (value.refresh_token !== undefined && !isString(value.refresh_token)) ||
    (value.id_token !== undefined && !isString(value.id_token)) ||
    (value.scope !== undefined && !isString(value.scope))
  ) {
    return undefined;
  }
  return {
    access_token: value.access_token,
    token_type: value.token_type,
    ...(value.expires_in === undefined
      ? undefined
      : { expires_in: value.expires_in }),
    ...(value.refresh_token === undefined
      ? undefined
      : { refresh_token: value.refresh_token }),
    ...(value.id_token === undefined
      ? undefined
      : { id_token: value.id_token }),
    ...(value.scope === undefined ? undefined : { scope: value.scope }),
  };
}

export class DeviceFlowClient {
  readonly #issuer: string;
  readonly #clientId: string;
  readonly #scopes: string;
  readonly #fetch: typeof fetch;
  readonly #sleep: (ms: number) => Promise<void>;
  #deviceCode: string | undefined;
  #intervalSeconds: number;
  /** When the device code the server issued stops being usable. */
  #expiresAt: number | undefined;
  #meta:
    | {
        device_authorization_endpoint: string;
        token_endpoint: string;
      }
    | undefined;

  constructor(private readonly config: DeviceFlowClientConfig) {
    this.#issuer = assertSecureUrl(trimSlash(config.issuer), "issuer");
    this.#clientId = config.clientId;
    this.#scopes = (config.scopes ?? ["openid", "profile"]).join(" ");
    this.#fetch = config.fetchImpl ?? fetch;
    this.#sleep = config.sleep ?? defaultSleep;
    this.#intervalSeconds = 5;
  }

  /** Internal device_code — never log or serialize to JSON output. */
  getDeviceCodeForTests(): string | undefined {
    return this.#deviceCode;
  }

  async #discovery() {
    if (this.#meta) return this.#meta;
    const res = await this.#fetch(
      `${this.#issuer}/.well-known/openid-configuration`,
    );
    if (!res.ok) throw new Error(`discovery failed: ${res.status}`);
    const raw: BoundaryValue = await res.json();
    const doc = parseJsonObject(raw, "discovery");
    assertDiscoveryBelongsToIssuer(
      isString(doc.issuer) ? { issuer: doc.issuer } : {},
      this.#issuer,
    );
    if (!isString(doc.device_authorization_endpoint)) {
      throw new Error(
        "issuer does not advertise device_authorization_endpoint",
      );
    }
    if (!isString(doc.token_endpoint)) {
      throw new Error("issuer does not advertise token_endpoint");
    }
    assertDiscoveredUrl(
      doc.device_authorization_endpoint,
      "device_authorization_endpoint",
      this.#issuer,
    );
    assertDiscoveredUrl(doc.token_endpoint, "token_endpoint", this.#issuer);
    this.#meta = {
      device_authorization_endpoint: doc.device_authorization_endpoint,
      token_endpoint: doc.token_endpoint,
    };
    return this.#meta;
  }

  async start(): Promise<SafeDeviceStart> {
    const meta = await this.#discovery();
    const body = new URLSearchParams({
      client_id: this.#clientId,
      scope: this.#scopes,
    });
    const init: RequestInit = {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    };
    if (this.config.signal) init.signal = this.config.signal;
    const res = await this.#fetch(meta.device_authorization_endpoint, init);
    if (!res.ok) {
      throw new Error(`device authorize failed: ${res.status}`);
    }
    const raw: BoundaryValue = await res.json();
    const data = parseDeviceAuthorizationResponse(raw);
    // These are the URIs the CLI prints for a person to open and type a code into.
    // Whatever answered here chooses them, so they are held to the same bar as the
    // endpoints: a device flow that sends the user to an attacker's page is a
    // phishing page with the CLI's own voice behind it.
    assertSecureUrl(data.verification_uri, "verification_uri");
    if (data.verification_uri_complete !== undefined) {
      assertSecureUrl(
        data.verification_uri_complete,
        "verification_uri_complete",
      );
    }
    this.#deviceCode = data.device_code;
    this.#intervalSeconds = Math.min(
      Math.max(
        Number.isFinite(data.interval) && (data.interval ?? 0) > 0
          ? (data.interval ?? 5)
          : 5,
        5,
      ),
      MAX_POLL_INTERVAL_SECONDS,
    );
    this.#expiresAt = Date.now() + data.expires_in * 1000;
    const safe: SafeDeviceStart = {
      userCode: data.user_code,
      verificationUri: data.verification_uri,
      expiresIn: data.expires_in,
      intervalSeconds: this.#intervalSeconds,
    };
    if (data.verification_uri_complete !== undefined) {
      safe.verificationUriComplete = data.verification_uri_complete;
    }
    return safe;
  }

  async pollOnce(): Promise<DevicePollResult> {
    if (!this.#deviceCode) {
      throw new Error("device flow not started");
    }
    const meta = await this.#discovery();
    const body = new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: this.#deviceCode,
      client_id: this.#clientId,
    });
    const init: RequestInit = {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    };
    if (this.config.signal) init.signal = this.config.signal;
    const res = await this.#fetch(meta.token_endpoint, init);
    const raw: BoundaryValue = await res.json();
    const json = isJsonObject(raw) ? raw : {};
    const tokens = parseTokenSuccess(json);
    if (res.ok && tokens) {
      return { status: "success", tokens };
    }
    const error = isString(json.error) ? json.error : "unknown";
    if (error === "authorization_pending") {
      return {
        status: "authorization_pending",
        intervalSeconds: this.#intervalSeconds,
      };
    }
    if (error === "slow_down") {
      this.#intervalSeconds = Math.min(
        this.#intervalSeconds + 5,
        MAX_POLL_INTERVAL_SECONDS,
      );
      return { status: "slow_down", intervalSeconds: this.#intervalSeconds };
    }
    if (error === "access_denied") return { status: "access_denied" };
    if (error === "expired_token") return { status: "expired_token" };
    const description = isString(json.error_description)
      ? json.error_description
      : undefined;
    return description !== undefined
      ? { status: "error", error, description }
      : { status: "error", error };
  }

  async pollUntilComplete(): Promise<TokenSuccess> {
    for (;;) {
      if (this.config.signal?.aborted) {
        throw new Error("aborted");
      }
      // The server told us when the device code dies. Polling past that is a loop
      // that never ends on a server that never says so.
      if (this.#expiresAt !== undefined && Date.now() >= this.#expiresAt) {
        throw new Error("expired_token");
      }
      const result = await this.pollOnce();
      switch (result.status) {
        case "success":
          return result.tokens;
        case "authorization_pending":
        case "slow_down":
          await this.#sleep(result.intervalSeconds * 1000);
          break;
        case "access_denied":
          throw new Error("access_denied");
        case "expired_token":
          throw new Error("expired_token");
        case "error":
          throw new Error(result.description ?? result.error);
      }
    }
  }

  /** Format user-facing instructions — never includes device_code. */
  formatInstructions(
    start: SafeDeviceStart,
    options: { qr?: boolean } = {},
  ): string {
    const lines = [
      "To sign in, enter this shortcode:",
      "",
      `  ${start.userCode}`,
      "",
      "at:",
      "",
      `  ${start.verificationUri}`,
    ];
    const scanUrl = start.verificationUriComplete ?? start.verificationUri;
    if (start.verificationUriComplete) {
      lines.push("", `Or open: ${start.verificationUriComplete}`);
    }
    if (options.qr) {
      lines.push("", encodeQrTerminal(scanUrl), "");
    }
    return lines.join("\n");
  }
}

/** Redact secrets from objects before JSON logging. */
export function redactSecrets(
  value: JsonValue | undefined,
): JsonValue | undefined {
  if (value === null || !isTypeofObject(value)) return value;
  if (Array.isArray(value)) {
    return value.map((item) => redactSecrets(item) ?? null);
  }
  const out: JsonObject = {};
  for (const [k, v] of Object.entries(value)) {
    if (
      /device_code|access_token|refresh_token|id_token|code_verifier|client_secret|client_assertion|claimToken|claim_token|operator|password|passphrase|secret|cookie|authorization|api[-_]?key|private_key|signing_key|bearer/iu.test(
        k,
      )
    ) {
      out[k] = "[redacted]";
    } else {
      out[k] = redactSecrets(v);
    }
  }
  return out;
}
