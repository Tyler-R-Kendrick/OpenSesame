import {
  type CanonicalizeOriginOptions,
  canonicalizeOrigin as canonicalizeDomainOrigin,
} from "@opensesame/os-domain";

export {
  type CanonicalizeOriginOptions,
  OriginError,
  type OriginErrorCode,
  defaultCallbackUri,
  originClientId,
  parseOriginClientId,
} from "@opensesame/os-domain";

/** Server compatibility wrapper: preserve the ambient production safeguard. */
export function canonicalizeOrigin(
  input: string,
  options: CanonicalizeOriginOptions = {},
): string {
  return canonicalizeDomainOrigin(input, {
    ...options,
    production: options.production ?? process.env.NODE_ENV === "production",
  });
}
