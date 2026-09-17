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

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    return undefined;
  }
  return value.filter((item) => item.length > 0);
}

export function parseApplicationSource(
  source: string,
  applicationId: string,
): ApplicationParseResult {
  const parsed = parseConfigYaml(source);
  if (!parsed.ok) return { ok: false, diagnostics: parsed.diagnostics };
  const organizationId = parsed.value.organizationId;
  const redirectUris = stringList(parsed.value.redirectUris);
  const scopes = stringList(parsed.value.scopes);
  if (typeof organizationId !== "string" || !redirectUris || !scopes) {
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
  if (
    typeof parsed.value.applicationId === "string" &&
    parsed.value.applicationId !== applicationId
  ) {
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
