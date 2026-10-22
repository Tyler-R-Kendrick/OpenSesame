import { overlapCast } from "@opensesame/os-domain";
import { mayPairLocalAuthority } from "./deployment-profile.js";

export const localNetworkFetchSeams = { eligible: mayPairLocalAuthority };
/**
 * Chrome Local Network Access (LNA): github.io → Tailscale CGNAT / .ts.net /
 * loopback needs an explicit address-space hint and hard timeouts. Without a
 * timeout, a fetch that pauses on the permission dialog (or hangs afterward)
 * freezes pairing UI on "Connecting…".
 */

export type TargetAddressSpace = "local" | "loopback" | "public";

const DEFAULT_MS = 4000;

/**
 * Classify a URL for RequestInit.targetAddressSpace when the browser supports
 * LNA. This follows the spec's non-public address table rather than guessing
 * from a prefix: `198.18.0.0/15` is loopback, `0.0.0.0/8` is local except the
 * null address itself, and IPv4-mapped IPv6 takes the embedded address's
 * space.
 */
export function targetAddressSpaceFor(
  url: string,
): TargetAddressSpace | undefined {
  let host: string;
  try {
    host = new URL(url, "https://example.invalid").hostname.toLowerCase();
  } catch {
    return undefined;
  }
  if (host === "localhost" || host.endsWith(".localhost")) return "loopback";
  if (host.endsWith(".local") || host.endsWith(".ts.net")) return "local";
  return addressSpaceFor(host);
}

function addressSpaceFor(host: string): TargetAddressSpace | undefined {
  const bare =
    host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (bare.includes(":")) return ipv6Space(bare.split("%")[0] ?? bare);
  return ipv4Space(bare);
}

function ipv4Space(host: string): TargetAddressSpace | undefined {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!match) return undefined;
  const octets = match.slice(1).map(Number);
  if (octets.some((octet) => octet > 255)) return undefined;
  const [a = 0, b = 0] = octets;
  if (a === 127) return "loopback";
  if (a === 0)
    return octets.every((octet) => octet === 0) ? "loopback" : "local";
  if (a === 198 && (b === 18 || b === 19)) return "loopback";
  return isPrivateV4(a, b) ? "local" : undefined;
}

function isPrivateV4(a: number, b: number): boolean {
  return (
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

function ipv6Space(host: string): TargetAddressSpace | undefined {
  const value = host.toLowerCase();
  if (value === "::" || value === "::1") return "loopback";
  if (value.startsWith("::ffff:")) return mappedIpv4Space(value);
  const [firstText = "0", secondText = "0"] = value.split(":");
  const first = Number.parseInt(firstText || "0", 16);
  const second = Number.parseInt(secondText || "0", 16);
  if (Number.isNaN(first) || Number.isNaN(second)) return undefined;
  return localIpv6Prefix(first, second) ? "local" : undefined;
}

function mappedIpv4Space(value: string): TargetAddressSpace | undefined {
  const mapped = value.slice("::ffff:".length);
  if (mapped.includes(".")) return ipv4Space(mapped);
  const groups = mapped.split(":");
  if (groups.length < 1 || groups.length > 2) return undefined;
  const high = Number.parseInt(groups.at(-2) ?? "0", 16);
  const low = Number.parseInt(groups.at(-1) ?? "0", 16);
  if (Number.isNaN(high) || Number.isNaN(low)) return undefined;
  const address = (high << 16) | low;
  return ipv4Space(
    `${(address >>> 24) & 255}.${(address >>> 16) & 255}.${(address >>> 8) & 255}.${address & 255}`,
  );
}

function localIpv6Prefix(first: number, second: number): boolean {
  if ((first & 0xfe00) === 0xfc00) return true;
  if ((first & 0xffc0) === 0xfe80) return true;
  if ((first & 0xffc0) === 0xfec0) return true;
  if (first === 0x2001 && second === 0x0db8) return true;
  return first === 0x3fff && second <= 0x0fff;
}

/**
 * Add the LNA address-space hint to a caller-owned RequestInit. Used by the
 * few local transports that need their own abort or response handling rather
 * than localNetworkFetch's timeout.
 */
export function withTargetAddressSpace(
  input: string,
  init: RequestInit,
): RequestInit {
  const space = targetAddressSpaceFor(input);
  if (space === undefined) return init;
  return overlapCast({ ...init, targetAddressSpace: space });
}

export type LocalNetworkFetchInit = RequestInit & {
  /** Override default timeout (ms). */
  timeoutMs?: number;
  /** Skip targetAddressSpace annotation. */
  skipAddressSpace?: boolean;
  /**
   * The request reads or writes ciphertext on a tailnet drive and carries no
   * operator authority (ADR 0144), so the deployment fence — which exists to
   * keep local authority off a shared origin — does not apply to it.
   */
  ciphertextDrive?: boolean;
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
    ciphertextDrive,
    signal: outer,
    ...rest
  } = init;
  const targetSpace = targetAddressSpaceFor(input);
  if (
    (targetSpace && !ciphertextDrive && !localNetworkFetchSeams.eligible()) ||
    new Headers(init.headers).has("X-OpenSesame-Operator")
  ) {
    throw new DOMException(
      "This browser deployment cannot use local operator authority.",
      "SecurityError",
    );
  }
  const space = skipAddressSpace ? undefined : targetSpace;
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
      overlapCast(requestInit).targetAddressSpace = space;
    }
    return await fetch(input, requestInit);
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener("abort", onOuterAbort);
  }
}
