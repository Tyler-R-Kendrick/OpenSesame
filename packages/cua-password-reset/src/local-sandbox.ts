import { randomUUID } from "node:crypto";
import { AgentBrowser, type AgentBrowserConfig } from "./agent-browser.js";

export interface LocalSandboxOptions {
  /** Exact origin the sandbox may navigate to; the allowlist is derived. */
  origin: string;
  /** Extra hostnames the ceremony may visit (e.g. an IdP host). */
  extraAllowedDomains?: readonly string[];
  executable?: string;
  browserExecutable?: string;
  timeoutMs?: number;
  session?: string;
  spawn?: AgentBrowserConfig["spawn"];
  secretFill?: AgentBrowserConfig["secretFill"];
  env?: Readonly<Record<string, string | undefined>>;
}

export interface LocalSandbox {
  browser: AgentBrowser;
  session: string;
  allowedDomains: readonly string[];
  origin: string;
  close(): Promise<void>;
}

/**
 * Zero-provision local sandbox: an ephemeral `agent-browser` session on the
 * user's own device. No cloud account, connection record, or config file is
 * required — the session name is random and the domain allowlist is derived
 * from the target origin. Secrets reach the page through the driver's
 * stdin batch fill (never argv).
 */
export function createLocalSandbox(options: LocalSandboxOptions): LocalSandbox {
  const url = credentialFreeHttpUrl(options.origin);
  const allowedDomains = [
    ...new Set([url.hostname, ...(options.extraAllowedDomains ?? [])]),
  ];
  for (const domain of allowedDomains) {
    if (!/^[a-z0-9.-]+$/iu.test(domain) || domain.includes(".."))
      throw new Error("Sandbox allowed domain is invalid");
  }
  const session = options.session ?? `cua-${randomUUID()}`;
  const env = options.env ?? process.env;
  const browserExecutable =
    options.browserExecutable ?? env.AGENT_BROWSER_CHROME;
  const browser = new AgentBrowser({
    executable: options.executable ?? env.AGENT_BROWSER ?? "agent-browser",
    session,
    allowedDomains,
    ...(browserExecutable ? { browserExecutable } : {}),
    ...(options.timeoutMs !== undefined
      ? { timeoutMs: options.timeoutMs }
      : {}),
    ...(options.spawn ? { spawn: options.spawn } : {}),
    ...(options.secretFill ? { secretFill: options.secretFill } : {}),
  });
  return {
    browser,
    session,
    allowedDomains,
    origin: url.origin,
    close: () => browser.close(),
  };
}

function credentialFreeHttpUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Browser URL must be a credential-free HTTP(S) URL");
  }
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error("Browser URL must be a credential-free HTTP(S) URL");
  return url;
}
