/**
 * A WebRTC session description, read strictly (ADR 0150 §3).
 *
 * A description arrives inside a sealed code from someone who holds the link
 * (a joiner's offer) or from the owner (an answer), and it is handed straight
 * to `setRemoteDescription`. This protocol needs exactly one thing from it: a
 * single SCTP data-channel section. So that is all that reads:
 *
 * - one `m=application <port> <proto> webrtc-datachannel` section — UDP, TCP
 *   or bare DTLS over SCTP, or the legacy numeric format with `a=sctpmap` —
 *   and no other media section, so a description cannot ask the browser for
 *   audio, video or a second transport;
 * - `a=candidate` lines parsed field by field: an IP literal or an mDNS
 *   `<uuid>.local` name, a real port, a known type, at most `CANDIDATES_MAX`
 *   of them;
 * - every other `a=` line by name. The attributes browsers put in a data
 *   channel description are known and their values checked; one this list does
 *   not know is let through if it is shaped like an attribute at all, because
 *   refusing a real browser's offer over an attribute nobody here has met
 *   costs a person their join. Only what carries addresses of its own
 *   (`remote-candidates`) is refused;
 * - printable ASCII, bounded lines, bounded lines in all.
 *
 * Real Chromium offers and answers are the test vectors
 * (`__fixtures__/chromium-sdp.json`).
 */

import { isAddress } from "./transport.js";

export const SDP_MAX = 48 * 1024;
export const CANDIDATES_MAX = 128;
const LINES_MAX = 320;
const LINE_MAX = 512;

const PRINTABLE = /^[\x20-\x7e]*$/;
const IPV4 =
  /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const IPV6 = /^[0-9A-Fa-f:.]{2,45}$/;
const MDNS =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.local$/i;

/** Any IP literal, the unspecified address included (`c=` and `raddr`). */
function isIp(value: string): boolean {
  if (IPV4.test(value)) return true;
  if (!IPV6.test(value) || !value.includes(":")) return false;
  try {
    return new URL(`http://[${value}]/`).hostname.length > 2;
  } catch {
    return false;
  }
}

function isPort(value: string, floor: number): boolean {
  if (!/^\d{1,5}$/.test(value)) return false;
  const port = Number(value);
  return port >= floor && port <= 65535;
}

const MEDIA =
  /^m=application (\d{1,5}) (?:UDP\/DTLS\/SCTP|DTLS\/SCTP|TCP\/DTLS\/SCTP) (?:webrtc-datachannel|\d{1,5})$/;
const ORIGIN =
  /^o=[\x21-\x7e]{1,64} \d{1,20} \d{1,20} IN IP[46] [\x21-\x7e]{1,64}$/;
const CONNECTION = /^c=IN IP[46] (\S{1,64})$/;
const TIMING = /^t=\d{1,20} \d{1,20}$/;
const NAME = /^s=[\x20-\x7e]{0,128}$/;
const BANDWIDTH = /^b=[A-Za-z-]{1,8}:\d{1,12}$/;

/**
 * `<foundation> <component> <transport> <priority> <address> <port> typ
 * <type>`, then extension pairs. The three captured are the ones checked
 * further: priority, address, port, and the extensions.
 */
const CANDIDATE =
  /^[A-Za-z0-9+/]{1,32} [12] (?:udp|UDP|tcp|TCP) (\d{1,10}) (\S{1,64}) (\d{1,5}) typ (?:host|srflx|prflx|relay)((?: \S+)*)$/;
const EXTENSION_NAME = /^[a-z][a-z0-9-]{0,31}$/;
const EXTENSION_VALUE = /^[\x21-\x7e]{1,64}$/;
const EXTENSIONS_MAX = 8;

function extensionValid(name: string, value: string): boolean {
  if (!EXTENSION_NAME.test(name) || !EXTENSION_VALUE.test(value)) return false;
  if (name === "raddr") return isIp(value);
  return name === "rport" ? isPort(value, 0) : true;
}

/** Extensions are name/value pairs: raddr, rport, tcptype, generation… */
function extensionsValid(tokens: readonly string[]): boolean {
  if (tokens.length % 2 !== 0 || tokens.length > EXTENSIONS_MAX * 2)
    return false;
  for (let at = 0; at < tokens.length; at += 2)
    if (!extensionValid(tokens[at] ?? "", tokens[at + 1] ?? "")) return false;
  return true;
}

function candidateValid(value: string): boolean {
  const parts = CANDIDATE.exec(value);
  if (!parts) return false;
  const [, priority = "", address = "", port = "", rest = ""] = parts;
  return (
    Number(priority) <= 2 ** 31 - 1 &&
    (isAddress(address) || MDNS.test(address)) &&
    isPort(port, 1) &&
    extensionsValid(rest.split(" ").slice(1))
  );
}

const TOKEN = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * The attributes a data-channel description carries, and what each one's
 * value must look like (`null`: it has none).
 */
const KNOWN = new Map<string, RegExp | null>([
  ["ice-ufrag", /^[A-Za-z0-9+/]{4,256}$/],
  ["ice-pwd", /^[A-Za-z0-9+/]{22,256}$/],
  ["ice-options", /^[a-z0-9-]{1,32}( [a-z0-9-]{1,32}){0,7}$/],
  ["fingerprint", /^[a-z0-9-]{3,16} [0-9A-Fa-f]{2}(:[0-9A-Fa-f]{2}){15,63}$/],
  ["setup", /^(?:actpass|active|passive|holdconn)$/],
  ["mid", TOKEN],
  ["sctp-port", /^\d{1,5}$/],
  ["max-message-size", /^\d{1,12}$/],
  ["sctpmap", /^\d{1,5} webrtc-datachannel \d{1,5}$/],
  ["group", /^[A-Z]{1,16}( [A-Za-z0-9._-]{1,64}){0,4}$/],
  ["msid-semantic", /^ ?[A-Za-z]{1,16}( \S{1,64}){0,4}$/],
  ["end-of-candidates", null],
  ["extmap-allow-mixed", null],
  ["ice-lite", null],
  ["sendrecv", null],
  ["sendonly", null],
  ["recvonly", null],
  ["inactive", null],
]);

/** An attribute this list has not met: shaped like one, and short. */
const ATTRIBUTE = /^a=([a-z0-9-]{1,64})(?::([\x20-\x7e]{0,400}))?$/;
/** Refused whatever it looks like: it names addresses of its own. */
const REFUSED = new Set(["remote-candidates"]);

function attributeValid(line: string): boolean {
  const parts = ATTRIBUTE.exec(line);
  const name = parts?.[1];
  if (!name || REFUSED.has(name)) return false;
  const value = parts[2] ?? null;
  if (name === "candidate") return value !== null && candidateValid(value);
  if (!KNOWN.has(name)) return true;
  const pattern = KNOWN.get(name) ?? null;
  return pattern === null
    ? value === null
    : value !== null && pattern.test(value);
}

/** What has been met so far: each line kind is counted, and bounded. */
type Tally = { o: number; s: number; t: number; m: number; c: number };

function sessionLineValid(
  kind: "o" | "s" | "t",
  line: string,
  tally: Tally,
): boolean {
  // Session-level only, once each, and before the media section.
  tally[kind] += 1;
  if (tally.m > 0 || tally[kind] > 1) return false;
  return { o: ORIGIN, s: NAME, t: TIMING }[kind].test(line);
}

/** One `c=` at the session level, one in the section. */
function connectionValid(line: string, tally: Tally): boolean {
  const address = CONNECTION.exec(line)?.[1];
  tally.c += 1;
  return !!address && isIp(address) && tally.c <= 2;
}

/** The one data-channel section. */
function mediaValid(line: string, tally: Tally): boolean {
  const port = MEDIA.exec(line)?.[1];
  tally.m += 1;
  return !!port && isPort(port, 0) && tally.m <= 1;
}

function lineValid(line: string, tally: Tally): boolean {
  if (line.length > LINE_MAX || !PRINTABLE.test(line) || line[1] !== "=")
    return false;
  switch (line[0]) {
    case "a":
      return attributeValid(line);
    case "b":
      return BANDWIDTH.test(line);
    case "c":
      return connectionValid(line, tally);
    case "m":
      return mediaValid(line, tally);
    case "o":
    case "s":
    case "t":
      return sessionLineValid(line[0], line, tally);
    default:
      return false;
  }
}

/**
 * True for exactly what the header describes: one data-channel section and
 * nothing this protocol did not ask a browser for.
 */
export function isDataChannelSdp(sdp: string): boolean {
  if (sdp.length > SDP_MAX || !sdp.startsWith("v=0")) return false;
  const lines = sdp.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  if (lines.length > LINES_MAX || lines[0] !== "v=0") return false;
  const body = lines.slice(1);
  const candidates = body.filter((line) => line.startsWith("a=candidate:"));
  if (candidates.length > CANDIDATES_MAX) return false;
  const tally: Tally = { o: 0, s: 0, t: 0, m: 0, c: 0 };
  if (!body.every((line) => lineValid(line, tally))) return false;
  return tally.o === 1 && tally.s === 1 && tally.t === 1 && tally.m === 1;
}
