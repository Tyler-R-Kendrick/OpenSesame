import { type BoundaryValue, isJsonObject } from "@opensesame/os-domain";

function objectPart(part: string) {
  const binary = atob(part.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  const value: BoundaryValue = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(bytes),
  );
  if (!isJsonObject(value)) throw new Error("invalid_token_envelope");
  return value;
}

/** Bounded syntax parsing only. This never authenticates a token or its claims. */
export function decodeJwtEnvelope(token: string) {
  const parts = token.length <= 16384 ? token.split(".") : [];
  const [header, claims] = parts;
  if (
    token.length > 16384 ||
    parts.length !== 3 ||
    !header ||
    !claims ||
    parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))
  ) {
    throw new Error("invalid_token_envelope");
  }
  return { header: objectPart(header), claims: objectPart(claims) };
}
