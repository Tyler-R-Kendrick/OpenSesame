/** Browser-only registration preparation and explicitly unverified credential handoff. */
import type { BoundaryValue } from "@opensesame/os-domain";
import {
  TAILSCALE_PROVISION_SCOPE,
  type TailscaleAppConfiguration,
  parseTailscaleApp,
  tailscaleAppConfiguration,
} from "./oauth-app.js";
export type TailscaleKeyHandoff = Readonly<{
  key: string;
  expiresAt: null;
  singleUse: null;
}>;
export function tailscaleRegistrationRequest(
  config: TailscaleAppConfiguration,
) {
  const checked = tailscaleAppConfiguration(config);
  const request = {
    name: checked.name,
    redirectUris: [checked.redirectUri],
    scopes: [TAILSCALE_PROVISION_SCOPE],
  };
  if (!checked.allowedNodeAttributes?.length) return request;
  return { ...request, allowedNodeAttributes: checked.allowedNodeAttributes };
}
export function tailscaleRegistrationArtifact(
  config: TailscaleAppConfiguration,
): string {
  return JSON.stringify(
    {
      format: "opensesame.tailscale-registration",
      version: 1,
      deploymentId: config.name.replace(/^OpenSesame /, ""),
      apiBase: config.apiBase,
      tailnet: config.tailnet,
      method: "POST",
      path: `/api/v2/tailnet/${encodeURIComponent(config.tailnet)}/oauth-apps`,
      request: tailscaleRegistrationRequest(config),
    },
    null,
    2,
  );
}
export function importTailscaleAppResponse(
  raw: string,
  config: TailscaleAppConfiguration,
) {
  if (new TextEncoder().encode(raw).length > 65536)
    throw new Error("The app response exceeds 64 KiB.");
  const parsed: BoundaryValue = JSON.parse(raw);
  return parseTailscaleApp(parsed, config);
}
export function tailscaleKeyHandoff(raw: string): TailscaleKeyHandoff {
  const key = raw.trim();
  if (!/^[!-~]{1,16384}$/u.test(key))
    throw new Error("Paste one provider-issued device auth key.");
  return Object.freeze({ key, expiresAt: null, singleUse: null });
}
