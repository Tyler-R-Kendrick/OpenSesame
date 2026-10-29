/**
 * The sandbox-provider contract every browser lane implements.
 *
 * A provider allocates one browser session for one agent run and hands back
 * a `BrowserDriver` (the CUA seam) plus lifecycle. Providers differ only in
 * where the browser lives and how its traffic reaches the site:
 *
 * - `local` — an ephemeral agent-browser session on the user's own device.
 * - `boat` — a Boat cloud sandbox allocated over the Boat REST API (auth.md
 *   registration means no pre-provisioned account); the driver runs inside
 *   the sandbox behind its host URL so secrets never enter Boat's command
 *   history.
 * - `cloudflare` — a Cloudflare Browser Run session allocated over REST and
 *   driven over CDP.
 * - `wasm-relay` — a DOM-level driver that needs no direct network: every
 *   fetch is virtualized through a relay, so the same driver code can run
 *   inside a WASM/browser host.
 *
 * Allocation is the only place credentials for the *provider* are read
 * (environment only). Site credentials never cross this contract: drivers
 * receive secret values per fill, exactly as with the local driver.
 */

import type { BrowserDriver } from "@opensesame/cua-password-reset";

export const SANDBOX_PROVIDER_IDS = [
  "local",
  "boat",
  "cloudflare",
  "wasm-relay",
] as const;
export type SandboxProviderId = (typeof SANDBOX_PROVIDER_IDS)[number];

export interface SandboxAllocationRequest {
  /** Exact origin the ceremony may navigate to; the allowlist is derived. */
  origin: string;
  /** Extra hostnames the ceremony may visit (e.g. an IdP host). */
  extraAllowedDomains?: readonly string[];
  /**
   * Stable session name for the run, when the caller needs a later
   * invocation (resume after takeover) to rejoin the same session.
   * Providers that cannot honor a caller-chosen name ignore it and return
   * their own session id in the allocation.
   */
  session?: string;
}

export interface AllocatedSandbox {
  provider: SandboxProviderId;
  /** Provider session identifier (also the takeover/resume handle). */
  session: string;
  browser: BrowserDriver;
  /** Hostnames this allocation may navigate to. */
  allowedDomains: readonly string[];
  /**
   * Where a person can watch or drive this session in a browser, when the
   * provider exposes one (Boat host URL, relay viewer, …). Never carries a
   * secret; provider access tokens stay in headers, not URLs we surface.
   */
  takeoverUrl?: string;
  close(): Promise<void>;
}

export interface SandboxProvider {
  readonly id: SandboxProviderId;
  allocate(request: SandboxAllocationRequest): Promise<AllocatedSandbox>;
}

/**
 * Allocation needs a person before it can proceed (e.g. the Boat auth.md
 * claim ceremony). Carries only what the person must see — a verification
 * URL and a short code — so callers can surface it through the existing
 * human-intervention channel (notifications queue + toast) instead of
 * inventing a second one.
 */
export class SandboxClaimRequiredError extends Error {
  readonly verificationUri: string;
  readonly userCode?: string;

  constructor(input: { verificationUri: string; userCode?: string }) {
    super("Sandbox allocation needs a person to claim this agent first");
    this.name = "SandboxClaimRequiredError";
    this.verificationUri = input.verificationUri;
    if (input.userCode !== undefined) this.userCode = input.userCode;
  }
}

/** Credential-free HTTP(S) origin check shared by every provider. */
export function sandboxOrigin(origin: string): URL {
  const url = new URL(origin);
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error("Sandbox origin must be a credential-free HTTP(S) URL");
  return url;
}

/** The navigation allowlist for an allocation: origin host plus extras. */
export function allowedDomainsFor(request: SandboxAllocationRequest) {
  const url = sandboxOrigin(request.origin);
  const allowedDomains = [
    ...new Set([url.hostname, ...(request.extraAllowedDomains ?? [])]),
  ];
  for (const domain of allowedDomains) {
    if (!/^[a-z0-9.-]+$/iu.test(domain) || domain.includes(".."))
      throw new Error("Sandbox allowed domain is invalid");
  }
  return { url, allowedDomains };
}
