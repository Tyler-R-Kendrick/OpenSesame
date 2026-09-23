import {
  type BoundaryValue,
  isString,
  overlapCast,
  readString,
} from "@opensesame/os-domain";
import type { LocalApplicationRegistration } from "../local-applications.js";
import type { ConfigDiagnostic } from "./types.js";
import { parseConfigYaml } from "./yaml-profile.js";

export function registrationToYaml(
  registration: LocalApplicationRegistration,
): string {
  const redirects = registration.redirectUris
    .map((uri) => `  - ${uri}`)
    .join("\n");
  const scopes = registration.scopes.map((scope) => `  - ${scope}`).join("\n");
  return `# Local application registration. Registration is not consent.
applicationId: ${registration.applicationId}
organizationId: ${registration.organizationId}
redirectUris:
${redirects}
scopes:
${scopes}
`;
}

export type ApplicationParseResult =
  | { ok: true; value: LocalApplicationRegistration }
  | { ok: false; diagnostics: ConfigDiagnostic[] };

function stringList(value: BoundaryValue): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings: string[] = [];
  for (const item of value) {
    if (!isString(item)) return undefined;
    strings.push(item);
  }
  return strings.filter((item) => item.length > 0);
}

export function parseApplicationSource(
  source: string,
  applicationId: string,
): ApplicationParseResult {
  const parsed = parseConfigYaml(source);
  if (!parsed.ok) return { ok: false, diagnostics: parsed.diagnostics };
  const raw = overlapCast(parsed.value);
  const organizationId = readString(raw.organizationId);
  const redirectUris = stringList(raw.redirectUris);
  const scopes = stringList(raw.scopes);
  if (organizationId === undefined || !redirectUris || !scopes) {
    return {
      ok: false,
      diagnostics: [
        {
          severity: "error",
          code: "shape",
          message: "Source must name organizationId, redirectUris, and scopes.",
        },
      ],
    };
  }
  const declaredId = readString(raw.applicationId);
  if (declaredId !== undefined && declaredId !== applicationId) {
    return {
      ok: false,
      diagnostics: [
        {
          severity: "error",
          code: "identity",
          message: "applicationId cannot be changed in source.",
        },
      ],
    };
  }
  return {
    ok: true,
    value: {
      applicationId,
      organizationId,
      redirectUris,
      scopes,
    },
  };
}
