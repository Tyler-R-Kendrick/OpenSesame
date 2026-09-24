import { isIP } from "node:net";

export type DeploymentMode = "development" | "test" | "production";
export type ExposureClass = "local_only" | "networked";

function mode(
  value: string | undefined,
  name: string,
): DeploymentMode | undefined {
  if (value === undefined) return undefined;
  if (value === "development" || value === "test" || value === "production")
    return value;
  throw new Error(`${name} must be development, test, or production`);
}

export function loopbackHost(host: string): boolean {
  const canonical = host.replace(/^\[/, "").replace(/\]$/, "");
  return (
    canonical === "localhost" ||
    canonical === "::1" ||
    canonical === "0:0:0:0:0:0:0:1" ||
    (isIP(canonical) === 4 && canonical.startsWith("127."))
  );
}

export function deploymentExposure(
  host: string,
  urls: string[],
): ExposureClass {
  let networked = !loopbackHost(host);
  for (const raw of urls) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new Error("Invalid deployment endpoint");
    }
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      throw new Error("Invalid deployment endpoint");
    }
    networked ||= !loopbackHost(url.hostname);
  }
  return networked ? "networked" : "local_only";
}

/** Credential-bearing service endpoints permit plaintext only on local transport. */
export function secureServiceEndpoint(raw: string, production = false): URL {
  deploymentExposure("127.0.0.1", [raw]);
  const url = new URL(raw);
  if (
    url.protocol !== "https:" &&
    (production || !loopbackHost(url.hostname))
  ) {
    throw new Error("Service endpoint requires HTTPS");
  }
  return url;
}

export function assertServiceEndpoints(
  endpoints: Record<string, string>,
  production: boolean,
): void {
  for (const [name, endpoint] of Object.entries(endpoints)) {
    try {
      secureServiceEndpoint(endpoint, production);
    } catch {
      throw new Error(`${name} requires HTTPS outside local development`);
    }
  }
}

export function resolveDeploymentMode(
  env: NodeJS.ProcessEnv,
  exposure: ExposureClass,
) {
  const declared = mode(env.OPENSESAME_ENV, "OPENSESAME_ENV");
  const node = mode(env.NODE_ENV, "NODE_ENV");
  if (declared && node && declared !== node)
    throw new Error("OPENSESAME_ENV conflicts with NODE_ENV");
  const optIn = env.OPENSESAME_ALLOW_DEV_DEFAULTS;
  if (optIn !== undefined && optIn !== "1" && optIn !== "0") {
    throw new Error("OPENSESAME_ALLOW_DEV_DEFAULTS must be 1 or 0");
  }
  const selected = declared ?? node;
  if (!selected && !(optIn === "1" && exposure === "local_only")) {
    throw new Error(
      "OPENSESAME_ENV or NODE_ENV must explicitly select development, test, or production",
    );
  }
  const resolved = selected ?? "development";
  const productionSafeguards =
    resolved === "production" || exposure === "networked";
  if (optIn === "1" && productionSafeguards)
    throw new Error(
      "Development defaults require local-only non-production exposure",
    );
  return {
    mode: resolved,
    exposure,
    productionSafeguards,
    allowDevDefaults: optIn === "1",
  };
}
