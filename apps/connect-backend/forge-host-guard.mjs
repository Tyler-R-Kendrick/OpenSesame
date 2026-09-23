/**
 * Where the git-backup relay may send a self-hosted Gitea/Forgejo request.
 *
 * `baseUrl` comes from the request body, so it is an address a stranger
 * chose. It must be a bare https origin — no userinfo, no path, no query, no
 * fragment — and it may not name, or resolve to, a loopback, private,
 * link-local, carrier-grade NAT, metadata or otherwise non-public address.
 * An operator may pin the accepted hosts with `OPENSESAME_GITEA_HOSTS`
 * (comma-separated `host` or `host:port`); a listed host is trusted as
 * written. DNS is checked before the request and the request itself refuses
 * redirects; a name that re-resolves between the check and the connection
 * is the residual the allowlist closes.
 */

import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

const BLOCKED_NAMES =
  /(^|\.)(localhost|local|internal|localdomain|home\.arpa)$/i;

/** IPv4 CIDR blocks that are not the public internet. */
const PRIVATE_V4 = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

function v4ToInt(address) {
  const parts = address.split(".").map(Number);
  return (
    ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3]
  );
}

function privateV4(address) {
  const value = v4ToInt(address);
  return PRIVATE_V4.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (value & mask) >>> 0 === (v4ToInt(base) & mask) >>> 0;
  });
}

/** Expand an IPv6 address into eight 16-bit groups. */
function v6Groups(address) {
  let text = address.toLowerCase();
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (tail) {
    const value = v4ToInt(tail[1]);
    text = text.replace(
      tail[1],
      `${(value >>> 16).toString(16)}:${(value & 0xffff).toString(16)}`,
    );
  }
  const [head, rest] = text.split("::");
  const left = head ? head.split(":") : [];
  const right = rest === undefined ? [] : rest ? rest.split(":") : [];
  const fill = rest === undefined ? 0 : 8 - left.length - right.length;
  return [...left, ...Array(fill).fill("0"), ...right].map((group) =>
    Number.parseInt(group, 16),
  );
}

function v4At(high, low) {
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].map(String).join(".");
}

/** The IPv4 address an IPv6 one carries (mapped, compatible, NAT64, 6to4). */
function carriedV4(groups) {
  const zeroPrefix = groups.slice(0, 5).every((group) => group === 0);
  if (zeroPrefix && (groups[5] === 0xffff || groups[5] === 0)) {
    return v4At(groups[6], groups[7]);
  }
  if (groups[0] === 0x64 && groups[1] === 0xff9b) {
    return v4At(groups[6], groups[7]);
  }
  if (groups[0] === 0x2002) return v4At(groups[1], groups[2]);
  return null;
}

/** [mask, value] over the first group: ULA, link-local, site-local, multicast. */
const PRIVATE_V6_PREFIXES = [
  [0xfe00, 0xfc00],
  [0xffc0, 0xfe80],
  [0xffc0, 0xfec0],
  [0xff00, 0xff00],
];

function privateV6(address) {
  const groups = v6Groups(address);
  if (groups.length !== 8 || groups.some(Number.isNaN)) return true;
  // :: (unspecified) and ::1 (loopback).
  if (groups.slice(0, 7).every((group) => group === 0) && groups[7] <= 1) {
    return true;
  }
  const v4 = carriedV4(groups);
  if (v4) return privateV4(v4);
  if (groups[0] === 0x2001 && groups[1] === 0x0db8) return true;
  return PRIVATE_V6_PREFIXES.some(
    ([mask, value]) => (groups[0] & mask) === value,
  );
}

/** True for any address that is not a public unicast one. */
export function isNonPublicAddress(address) {
  const family = isIP(address);
  if (family === 4) return privateV4(address);
  if (family === 6) return privateV6(address);
  return true;
}

function operatorHosts() {
  return new Set(
    (process.env.OPENSESAME_GITEA_HOSTS ?? "")
      .split(",")
      .map((part) => part.trim().toLowerCase())
      .filter(Boolean),
  );
}

function bareHttpsOrigin(raw) {
  if (typeof raw !== "string" || /[?#@\\]/.test(raw)) return null;
  let url;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.username || url.password || url.search || url.hash) return null;
  if (url.pathname !== "/" && url.pathname !== "") return null;
  return url;
}

async function resolvesPublic(hostname, lookup) {
  const literal = hostname.replace(/^\[|\]$/g, "");
  if (isIP(literal)) return !isNonPublicAddress(literal);
  if (BLOCKED_NAMES.test(literal.replace(/\.$/, ""))) return false;
  let answers;
  try {
    answers = await lookup(literal, { all: true, verbatim: true });
  } catch {
    return false;
  }
  if (!Array.isArray(answers) || answers.length === 0) return false;
  return answers.every(
    (answer) => answer && !isNonPublicAddress(String(answer.address)),
  );
}

/**
 * The `https://host[:port]` a Gitea request may go to, or null when
 * `baseUrl` is not one. `lookup` is injectable for tests.
 */
export async function giteaBaseAllowed(raw, lookup = dnsLookup) {
  const url = bareHttpsOrigin(raw);
  if (!url) return null;
  const pinned = operatorHosts();
  if (pinned.size > 0) {
    const listed =
      pinned.has(url.host.toLowerCase()) ||
      pinned.has(url.hostname.toLowerCase());
    return listed ? url.origin : null;
  }
  return (await resolvesPublic(url.hostname, lookup)) ? url.origin : null;
}
