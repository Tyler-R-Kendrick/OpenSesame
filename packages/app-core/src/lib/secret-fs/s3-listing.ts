/**
 * Reading a `ListObjectsV2` answer (ADR 0182). The answer is XML, a browser
 * and Node parse it differently, and only two things in it matter — the keys
 * and whether to ask again — so this reads exactly those and nothing else.
 * Keys are checked as paths by the caller; an entity in one decodes here.
 */
const ENTITIES = new Map([
  ["amp", "&"],
  ["lt", "<"],
  ["gt", ">"],
  ["quot", '"'],
  ["apos", "'"],
]);

function decode(text: string): string {
  return text.replace(
    /&(#x[0-9a-f]+|#\d+|[a-z]+);/gi,
    (whole, name: string) => {
      if (name.startsWith("#")) {
        const code =
          name[1] === "x" || name[1] === "X"
            ? Number.parseInt(name.slice(2), 16)
            : Number.parseInt(name.slice(1), 10);
        return Number.isInteger(code) && code >= 0 && code <= 0x10ffff
          ? String.fromCodePoint(code)
          : whole;
      }
      return ENTITIES.get(name) ?? whole;
    },
  );
}

/** Every object key in a listing. */
export function keysOf(xml: string): ReadonlyArray<string> {
  return [...xml.matchAll(/<Contents>[\s\S]*?<Key>([\s\S]*?)<\/Key>/g)].flatMap(
    (match) => (match[1] === undefined ? [] : [decode(match[1])]),
  );
}

/** The token to continue from, or `null` when the listing is complete. */
export function moreAfter(xml: string): string | null {
  if (!/<IsTruncated>true<\/IsTruncated>/.test(xml)) return null;
  const token =
    /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml);
  return token?.[1] === undefined ? null : decode(token[1]);
}
