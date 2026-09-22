/**
 * Static hosting constraints (BUILD-D).
 * Pages remains HTTPS / subpath / CSP-friendly; no mandatory loopback or Identity.
 */

export type StaticConstraintProbe = Readonly<{
  /** Source text under feature/ and related loaders. */
  sources: readonly string[];
  basePath?: string;
}>;

export type StaticConstraintReport = Readonly<{
  ok: boolean;
  httpsCompatible: boolean;
  subpathCompatible: boolean;
  forbidsMandatoryLoopback: boolean;
  forbidsMandatoryIdentity: boolean;
  violations: readonly string[];
}>;

const LOOPBACK_RE =
  /(?:https?:)?\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?/i;
const IDENTITY_MANDATORY_RE =
  /(?:require(?:s|d)?|mandatory|must)\s+identity|identity\s+required|fetch\(\s*['"`][^'"`]*identity/i;

/**
 * Static analysis over provided source strings. Does not start a network.
 */
export function checkStaticHostingConstraints(
  probe: StaticConstraintProbe,
): StaticConstraintReport {
  const violations: string[] = [];
  const joined = probe.sources.join("\n");

  for (const [i, src] of probe.sources.entries()) {
    if (LOOPBACK_RE.test(src)) {
      violations.push(`loopback_reference:source[${i}]`);
    }
  }

  if (IDENTITY_MANDATORY_RE.test(joined)) {
    violations.push("mandatory_identity_traffic");
  }

  const base = probe.basePath ?? "/OpenSesame/";
  const subpathCompatible = base.startsWith("/") && base.endsWith("/");
  if (!subpathCompatible) {
    violations.push(`bad_base_path:${base}`);
  }

  const httpsCompatible = !/http:\/\/(?!127\.|localhost)/i.test(joined);
  if (!httpsCompatible) {
    violations.push("insecure_http_absolute_url");
  }

  return {
    ok: violations.length === 0,
    httpsCompatible,
    subpathCompatible,
    forbidsMandatoryLoopback: !violations.some((v) =>
      v.startsWith("loopback_reference"),
    ),
    forbidsMandatoryIdentity: !violations.includes(
      "mandatory_identity_traffic",
    ),
    violations,
  };
}

/** Declared product constraints for verify scripts / docs honesty labels. */
export const DURESS_STATIC_CONSTRAINTS = Object.freeze({
  hosting: "static_https_subpath",
  mandatoryDaemon: false,
  mandatoryIdentity: false,
  mandatoryLoopback: false,
  mandatoryTailscale: false,
  cspFriendly: true,
} as const);
