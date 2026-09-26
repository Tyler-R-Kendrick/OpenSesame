/**
 * Subject alternative name inputs, checked before they reach a certificate:
 * DNS names as RFC 1035 hostnames (ASCII, with an optional `*` leftmost
 * label), and IP addresses parsed to the network-order octets RFC 5280
 * §4.2.1.6 puts in an iPAddress entry (4 for IPv4, 16 for IPv6).
 */

const LABEL = /^(?!-)[A-Za-z0-9-]{1,63}(?<!-)$/;

/**
 * A hostname a dNSName entry may carry: 1-253 ASCII characters in labels of
 * letters, digits and inner hyphens, a wildcard only as the whole leftmost
 * label, and a final label that is not all digits (so an IPv4 address typed
 * in the wrong field is refused rather than certified as a name).
 */
export function isDnsName(name: string): boolean {
  if (name.length === 0 || name.length > 253) return false;
  const labels = name.split(".");
  const [first, ...rest] = labels;
  if (first === "*" && rest.length === 0) return false;
  const checked = first === "*" ? rest : labels;
  if (!checked.every((label) => LABEL.test(label))) return false;
  return !/^\d+$/.test(labels[labels.length - 1] ?? "");
}

/** Dotted-quad IPv4, four decimal octets with no leading zeros. */
export function parseIpv4(text: string): Uint8Array | null {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^(0|[1-9]\d{0,2})$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    octets.push(value);
  }
  return Uint8Array.from(octets);
}

/** Hex groups to 16-bit words, with an optional dotted-quad tail. */
function words(groups: readonly string[], allowIpv4Tail: boolean) {
  const out: number[] = [];
  for (const [index, group] of groups.entries()) {
    if (allowIpv4Tail && index === groups.length - 1 && group.includes(".")) {
      const tail = parseIpv4(group);
      if (tail === null) return null;
      out.push(
        ((tail[0] ?? 0) << 8) | (tail[1] ?? 0),
        ((tail[2] ?? 0) << 8) | (tail[3] ?? 0),
      );
    } else if (/^[0-9A-Fa-f]{1,4}$/.test(group)) {
      out.push(Number.parseInt(group, 16));
    } else {
      return null;
    }
  }
  return out;
}

/**
 * RFC 4291 §2.2 text form: eight hex groups, one `::` standing for one or
 * more zero groups, and an optional dotted-quad in the last 32 bits. Zone
 * identifiers and brackets are refused; a certificate names no zone.
 */
export function parseIpv6(text: string): Uint8Array | null {
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const split = (part: string) => (part === "" ? [] : part.split(":"));
  const compressed = halves.length === 2;
  const head = split(halves[0] ?? "");
  const tail = compressed ? split(halves[1] ?? "") : [];
  const headWords = words(head, !compressed);
  const tailWords = words(tail, true);
  if (headWords === null || tailWords === null) return null;
  const present = headWords.length + tailWords.length;
  if (compressed ? present > 7 : present !== 8) return null;
  const all = [
    ...headWords,
    ...new Array<number>(8 - present).fill(0),
    ...tailWords,
  ];
  const bytes = new Uint8Array(16);
  for (const [index, word] of all.entries()) {
    bytes[index * 2] = word >> 8;
    bytes[index * 2 + 1] = word & 0xff;
  }
  return bytes;
}

/** An IPv4 or IPv6 address as iPAddress octets, or null when it is neither. */
export function parseIpAddress(text: string): Uint8Array | null {
  return text.includes(":") ? parseIpv6(text) : parseIpv4(text);
}
