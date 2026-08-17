import {
  assertDiscoveredUrl,
  assertDiscoveryBelongsToIssuer,
  assertSecureUrl,
  trimSlash,
} from "./secure-url.js";
import { encodeQrTerminal } from "@opensesame/qr";

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
    const doc = (await res.json()) as {
      issuer?: string;
      device_authorization_endpoint?: string;
      token_endpoint: string;
    };
    assertDiscoveryBelongsToIssuer(doc, this.#issuer);
    if (!doc.device_authorization_endpoint) {
      throw new Error(
        "issuer does not advertise device_authorization_endpoint",
      );
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
    const data = (await res.json()) as DeviceAuthorizationResponse;
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
      data.interval ?? 5,
      MAX_POLL_INTERVAL_SECONDS,
    );
    this.#expiresAt =
      typeof data.expires_in === "number"
        ? Date.now() + data.expires_in * 1000
        : undefined;
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
    const json = (await res.json()) as Record<string, unknown>;
    if (res.ok && typeof json.access_token === "string") {
      return { status: "success", tokens: json as unknown as TokenSuccess };
    }
    const error = String(json.error ?? "unknown");
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
    const description =
      typeof json.error_description === "string"
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
export function redactSecrets<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.map((v) => redactSecrets(v)) as T;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (
      /device_code|access_token|refresh_token|id_token|code_verifier|client_secret|client_assertion|claimToken|claim_token|operator|password|secret|cookie|authorization|api[-_]?key/iu.test(
        k,
      )
    ) {
      out[k] = "[redacted]";
    } else {
      out[k] = redactSecrets(v);
    }
  }
  return out as T;
}
