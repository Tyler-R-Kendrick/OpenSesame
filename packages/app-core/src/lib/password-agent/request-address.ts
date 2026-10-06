export interface Address {
  address: string;
  family: 4 | 6;
}
const blockedV4 = [
  [0, 8],
  [0x0a000000, 8],
  [0x64400000, 10],
  [0x7f000000, 8],
  [0xa9fe0000, 16],
  [0xac100000, 12],
  [0xc0000000, 24],
  [0xc0000200, 24],
  [0xc0586300, 24],
  [0xc0a80000, 16],
  [0xc6120000, 15],
  [0xc6336400, 24],
  [0xcb007100, 24],
  [0xe0000000, 4],
  [0xf0000000, 4],
];
function publicV4(address: string): boolean {
  const parts = address.split(".");
  if (
    parts.length !== 4 ||
    parts.some((part) => !/^(?:0|[1-9]\d{0,2})$/.test(part))
  )
    return false;
  const values = parts.map(Number);
  if (values.some((part) => part > 255)) return false;
  const value = values.reduce((sum, part) => sum * 256 + part, 0);
  return !blockedV4.some(
    ([network = 0, bits = 0]) =>
      Math.floor(value / 2 ** (32 - bits)) ===
      Math.floor(network / 2 ** (32 - bits)),
  );
}
function ipv6Words(address: string): string[] | undefined {
  if (!/^[a-fA-F\d:]+$/.test(address) || address.includes(":::"))
    return undefined;
  const halves = address.split("::");
  if (halves.length > 2) return undefined;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if (halves.length === 1 && missing !== 0) return undefined;
  if (halves.length === 2 && missing < 1) return undefined;
  const words = [
    ...left,
    ...Array.from({ length: missing }, () => "0"),
    ...right,
  ];
  if (words.some((word) => !/^[a-fA-F\d]{1,4}$/.test(word))) return undefined;
  return words;
}
function publicV6(address: string): boolean {
  const words = ipv6Words(address);
  if (!words) return false;
  const first = Number.parseInt(words[0] ?? "0", 16);
  const second = Number.parseInt(words[1] ?? "0", 16);
  if (first < 0x2000 || first > 0x3fff) return false;
  if (first === 0x2001 && (second < 0x0200 || second === 0x0db8)) return false;
  return first !== 0x2002 && first !== 0x3ffe && first !== 0x3fff;
}
/** Conservative global-unicast policy; mapped, transition and special ranges are denied. */
export function isPublicAddress(address: Address): boolean {
  if (address.family !== 4 && address.family !== 6) return false;
  return address.family === 4
    ? publicV4(address.address)
    : publicV6(address.address);
}
