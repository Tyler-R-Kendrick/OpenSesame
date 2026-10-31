/**
 * Local ephemeral provider: an agent-browser session on the user's own
 * device (see `createLocalSandbox`). No account, connection record, or
 * config file is required — this is the zero-provision default lane.
 */

import { createHash, randomUUID } from "node:crypto";
import {
  type LocalSandboxOptions,
  createLocalSandbox,
} from "@opensesame/cua-password-reset";
import {
  type AllocatedSandbox,
  type SandboxAllocationRequest,
  type SandboxProvider,
  allowedDomainsFor,
} from "./types.js";

// agent-browser uses session names in local socket paths; keep them short.
const SESSION_PREFIX = "cua1-";
const SESSION_HANDLE = /^cua1-([A-Za-z0-9_-]{22})-([A-Za-z0-9_-]{22})$/u;

function digest(value: string): string {
  return createHash("sha256")
    .update(value)
    .digest()
    .subarray(0, 16)
    .toString("base64url");
}

/** Bind an agent-browser session to the complete allocation policy. */
function localSession(request: SandboxAllocationRequest): string {
  const { url, allowedDomains } = allowedDomainsFor(request);
  const policy = digest(
    JSON.stringify([url.origin, [...allowedDomains].sort()]),
  );
  const requested = request.session;
  if (requested !== undefined) {
    if (!requested.trim() || requested.length > 512)
      throw new Error("Sandbox session must be a nonempty bounded string");
    if (requested.startsWith(SESSION_PREFIX)) {
      const match = SESSION_HANDLE.exec(requested);
      if (!match || match[1] !== policy)
        throw new Error("Sandbox session does not match the allocation policy");
      return requested;
    }
  }
  return `${SESSION_PREFIX}${policy}-${digest(requested ?? randomUUID())}`;
}

export type LocalProviderOptions = Omit<
  LocalSandboxOptions,
  "origin" | "extraAllowedDomains" | "session"
>;

export class LocalSandboxProvider implements SandboxProvider {
  readonly id = "local" as const;

  constructor(private readonly options: LocalProviderOptions = {}) {}

  async allocate(request: SandboxAllocationRequest): Promise<AllocatedSandbox> {
    const options: LocalSandboxOptions = {
      ...this.options,
      origin: request.origin,
      extraAllowedDomains: request.extraAllowedDomains ?? [],
    };
    options.session = localSession(request);
    const sandbox = createLocalSandbox(options);
    return {
      provider: this.id,
      session: sandbox.session,
      browser: sandbox.browser,
      allowedDomains: sandbox.allowedDomains,
      close: () => sandbox.close(),
    };
  }
}
