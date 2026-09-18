import type { VaultPrefs } from "../vault/store.js";
import { PREFS_SCHEMA_VERSION, PREFS_SYSTEM_FIELDS } from "./prefs-keys.js";
import type { ConfigDiagnostic } from "./types.js";
import { parseConfigYaml } from "./yaml-profile.js";

const THEMES = new Set(["system", "light", "dark"]);

export type PrefsDocument = {
  theme: VaultPrefs["theme"];
  autoLockMinutes: number;
  lockOnHide: boolean;
  signOutOnLock: boolean;
  clipboardClearSeconds: number;
};

export function prefsToYaml(prefs: VaultPrefs, comment?: string): string {
  const header = comment ? `${comment.trimEnd()}\n` : "";
  return `${header}theme: ${prefs.theme}
autoLockMinutes: ${prefs.autoLockMinutes}
lockOnHide: ${prefs.lockOnHide}
signOutOnLock: ${prefs.signOutOnLock}
clipboardClearSeconds: ${prefs.clipboardClearSeconds}
`;
}

function asBoolean(
  value: unknown,
  key: string,
  diagnostics: ConfigDiagnostic[],
): boolean | undefined {
  if (typeof value === "boolean") return value;
  diagnostics.push({
    severity: "error",
    code: "type",
    message: `${key} must be a boolean.`,
  });
  return undefined;
}

function asFiniteNumber(
  value: unknown,
  key: string,
  diagnostics: ConfigDiagnostic[],
): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return value;
  }
  diagnostics.push({
    severity: "error",
    code: "type",
    message: `${key} must be a non-negative finite number.`,
  });
  return undefined;
}

export type PrefsValidateResult =
  | { ok: true; value: PrefsDocument }
  | { ok: false; diagnostics: ConfigDiagnostic[] };

const KNOWN_FIELDS = new Set([
  "theme",
  "autoLockMinutes",
  "lockOnHide",
  "signOutOnLock",
  "clipboardClearSeconds",
  "schemaVersion",
  ...PREFS_SYSTEM_FIELDS,
]);

function collectFieldErrors(raw: Record<string, unknown>): ConfigDiagnostic[] {
  const diagnostics: ConfigDiagnostic[] = [];
  for (const key of PREFS_SYSTEM_FIELDS) {
    if (key in raw) {
      diagnostics.push({
        severity: "error",
        code: "system_field",
        message: `${key} is system-managed and cannot be set from source.`,
      });
    }
  }
  for (const key of Object.keys(raw)) {
    if (!KNOWN_FIELDS.has(key)) {
      diagnostics.push({
        severity: "error",
        code: "unknown_field",
        message: `Unknown field "${key}".`,
      });
    }
  }
  const schemaVersion = raw.schemaVersion;
  if (schemaVersion !== undefined) {
    if (
      typeof schemaVersion !== "number" ||
      !Number.isInteger(schemaVersion) ||
      schemaVersion > PREFS_SCHEMA_VERSION
    ) {
      diagnostics.push({
        severity: "error",
        code: "unsupported_version",
        message:
          "This preferences document uses a newer schema and opens read-only.",
      });
    }
  }
  const theme = raw.theme;
  if (
    theme !== undefined &&
    (typeof theme !== "string" || !THEMES.has(theme))
  ) {
    diagnostics.push({
      severity: "error",
      code: "type",
      message: 'theme must be "system", "light", or "dark".',
    });
  }
  return diagnostics;
}

/** Map a YAML object onto VaultPrefs. System fields cannot be written. */
export function validatePrefsDocument(
  raw: Record<string, unknown>,
): PrefsValidateResult {
  const diagnostics = collectFieldErrors(raw);
  const autoLockMinutes =
    raw.autoLockMinutes === undefined
      ? 0
      : asFiniteNumber(raw.autoLockMinutes, "autoLockMinutes", diagnostics);
  const clipboardClearSeconds =
    raw.clipboardClearSeconds === undefined
      ? 30
      : asFiniteNumber(
          raw.clipboardClearSeconds,
          "clipboardClearSeconds",
          diagnostics,
        );
  const lockOnHide =
    raw.lockOnHide === undefined
      ? false
      : asBoolean(raw.lockOnHide, "lockOnHide", diagnostics);
  const signOutOnLock =
    raw.signOutOnLock === undefined
      ? false
      : asBoolean(raw.signOutOnLock, "signOutOnLock", diagnostics);
  if (diagnostics.length > 0) return { ok: false, diagnostics };
  const theme = raw.theme;
  return {
    ok: true,
    value: {
      theme: (theme as PrefsDocument["theme"] | undefined) ?? "system",
      autoLockMinutes: autoLockMinutes ?? 0,
      clipboardClearSeconds: clipboardClearSeconds ?? 30,
      lockOnHide: lockOnHide ?? false,
      signOutOnLock: signOutOnLock ?? false,
    },
  };
}

export function parsePrefsSource(source: string): PrefsValidateResult {
  if (source.trim() === "") {
    return {
      ok: false,
      diagnostics: [
        {
          severity: "error",
          code: "empty",
          message: "Document is empty; original bytes are kept, not defaults.",
        },
      ],
    };
  }
  const parsed = parseConfigYaml(source);
  if (!parsed.ok) {
    return {
      ok: false,
      diagnostics: parsed.diagnostics,
    };
  }
  return validatePrefsDocument(parsed.value);
}
