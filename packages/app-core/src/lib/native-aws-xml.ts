/**
 * AWS's query-protocol services (STS) answer in XML. This reads the few
 * values a connection needs from a bounded body, and nothing else: no
 * document type, no entity, no parser a hostile reply could steer.
 */
import { NativeApiError } from "./native-api-http.js";

const ENTITIES = new Map([
  ["&amp;", "&"],
  ["&lt;", "<"],
  ["&gt;", ">"],
  ["&quot;", '"'],
  ["&apos;", "'"],
]);

function decode(text: string): string {
  return text.replace(
    /&(?:amp|lt|gt|quot|apos);/g,
    (entity) => ENTITIES.get(entity) ?? entity,
  );
}

/** The text of the element at this path of tag names, or null where the reply has none. */
export function awsXmlValue(
  body: string,
  path: readonly string[],
): string | null {
  if (/<!(?:DOCTYPE|ENTITY)/i.test(body)) throw new NativeApiError("response");
  let scope = body;
  for (const tag of path) {
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(tag))
      throw new NativeApiError("response");
    const match = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`).exec(
      scope,
    );
    if (!match) return null;
    scope = match[1] ?? "";
  }
  return decode(scope.trim());
}

/** A value the reply must hold, in the form AWS promises, or the reply is not one this reads. */
export function awsXmlRequired(
  body: string,
  path: readonly string[],
  pattern: RegExp,
): string {
  const value = awsXmlValue(body, path);
  if (value === null || value.length > 4096 || !pattern.test(value))
    throw new NativeApiError("response");
  return value;
}
