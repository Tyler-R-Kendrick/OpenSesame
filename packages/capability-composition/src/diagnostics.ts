/**
 * Diagnostics, validation and parse results.
 *
 * A diagnostic names a code, a human-readable message, and the JSONPath-like
 * provenance of the offending value (`capabilities.optional[3]`). Messages
 * quote identifiers only — never a value that could be a secret.
 */

export type Diagnostic = Readonly<{ code: string; message: string; path: string }>;

export type ValidationResult = Readonly<
  { ok: true } | { ok: false; diagnostics: readonly Diagnostic[] }
>;

export type ParseResult<T> = Readonly<
  { ok: true; value: T } | { ok: false; diagnostics: readonly Diagnostic[] }
>;

/** Every diagnostic code a parser or validator in this package can emit. */
export const DIAGNOSTIC_CODES = [
  "NOT_OBJECT",
  "MISSING_FIELD",
  "UNKNOWN_FIELD",
  "INVALID_TYPE",
  "INVALID_VALUE",
  "INVALID_LENGTH",
  "INVALID_ID",
  "DUPLICATE_ID",
  "CONFLICTING_SETS",
  "TOO_MANY_ITEMS",
  "INVALID_DIGEST",
  "UNKNOWN_CAPABILITY",
  "UNKNOWN_MODULE",
  "UNKNOWN_SLOT",
  "CORE_IN_POLICY",
  "DEPENDENCY_CYCLE",
  "DEPENDENCY_DEPTH",
  "CORE_DEPENDS_ON_OPTIONAL",
  "CATALOG_TOO_LARGE",
] as const;

export type DiagnosticCode = (typeof DIAGNOSTIC_CODES)[number];

/** Diagnostics are bounded so a hostile document cannot produce an unbounded report. */
export const MAX_DIAGNOSTICS = 128;

export function diagnostic(
  code: DiagnosticCode,
  path: string,
  message: string,
): Diagnostic {
  return { code, message, path };
}

/** Appends unless the bound is reached; the last slot records the truncation. */
export function pushDiagnostic(
  into: Diagnostic[],
  entry: Diagnostic,
): void {
  if (into.length < MAX_DIAGNOSTICS - 1) {
    into.push(entry);
    return;
  }
  if (into.length === MAX_DIAGNOSTICS - 1) {
    into.push(
      diagnostic(
        "TOO_MANY_ITEMS",
        "",
        `more than ${MAX_DIAGNOSTICS - 1} diagnostics; report truncated`,
      ),
    );
  }
}

export function validationOf(diagnostics: readonly Diagnostic[]): ValidationResult {
  return diagnostics.length === 0 ? { ok: true } : { ok: false, diagnostics };
}

/** A failed parse; the diagnostics say why (never empty in practice). */
export function parseFailure<T>(diagnostics: readonly Diagnostic[]): ParseResult<T> {
  return {
    ok: false,
    diagnostics:
      diagnostics.length > 0
        ? diagnostics
        : [diagnostic("INVALID_VALUE", "", "document could not be assembled")],
  };
}

export function parseResultOf<T>(
  diagnostics: readonly Diagnostic[],
  value: T | undefined,
): ParseResult<T> {
  if (diagnostics.length === 0 && value !== undefined) {
    return { ok: true, value };
  }
  return { ok: false, diagnostics };
}
