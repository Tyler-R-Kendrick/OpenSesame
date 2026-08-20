import { overlapCast } from "@opensesame/os-domain";
/**
 * Chrome Local Network Access (LNA): github.io → Tailscale CGNAT / .ts.net /
 * loopback needs an explicit address-space hint and hard timeouts. Without a
 * timeout, a fetch that pauses on the permission dialog (or hangs afterward)
 * freezes pairing UI on "Connecting…".
 */

export type TargetAddressSpace = "local" | "loopback" | "public";

const DEFAULT_MS = 4000;

/** Classify a URL for RequestInit.targetAddressSpace when the browser supports LNA. */
export function targetAddressSpaceFor(
  url: string,
): TargetAddressSpace | undefined {
  let host: string;
  try {
    host = new URL(url, "https://example.invalid").hostname.toLowerCase();
  } catch {
    return undefined;
  }
  if (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "[::1]" ||
    host === "::1" ||
    host.endsWith(".localhost")
  ) {
    return "loopback";
  }
  if (
    host.endsWith(".ts.net") ||
    host.endsWith(".local") ||
    host === "hello.ts.net" ||
    isRfc1918(host) ||
    isCgnat(host) ||
    isLinkLocal(host)
  ) {
    return "local";
  }
  return undefined;
}

function isRfc1918(host: string): boolean {
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return false;
}

function isCgnat(host: string): boolean {
  return /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}$/.test(host);
}

function isLinkLocal(host: string): boolean {
  return /^169\.254\.\d{1,3}\.\d{1,3}$/.test(host);
}

export type LocalNetworkFetchInit = RequestInit & {
  /** Override default timeout (ms). */
  timeoutMs?: number;
  /** Skip targetAddressSpace annotation. */
  skipAddressSpace?: boolean;
};

/**
 * fetch() with AbortSignal timeout + optional LNA targetAddressSpace.
 *
 * Uses a manual AbortController so the timer keeps running while Chrome shows
 * the "allow local network" prompt (AbortSignal.timeout alone has been flaky).
 */
export async function localNetworkFetch(
  input: string,
  init: LocalNetworkFetchInit = {},
): Promise<Response> {
  const {
    timeoutMs = DEFAULT_MS,
    skipAddressSpace,
    signal: outer,
    ...rest
  } = init;
  const space = skipAddressSpace ? undefined : targetAddressSpaceFor(input);
  const controller = new AbortController();
  const onOuterAbort = () => controller.abort(outer?.reason);
  if (outer) {
    if (outer.aborted) controller.abort(outer.reason);
    else outer.addEventListener("abort", onOuterAbort, { once: true });
  }
  const timer = setTimeout(() => {
    controller.abort(
      new DOMException(`Timed out after ${timeoutMs}ms`, "TimeoutError"),
    );
  }, timeoutMs);
  try {
    const requestInit: RequestInit = {
      ...rest,
      signal: controller.signal,
    };
    if (space) {
      // Not in all TypeScript DOM libs yet; browsers that ignore it are fine.
      (
        overlapCast(requestInit)
      ).targetAddressSpace = space;
    }
    return await fetch(input, requestInit);
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener("abort", onOuterAbort);
  }
}
