import {
  type Unregister,
  type WebMcpToolSpec,
  createWebMcpRegistrar,
  detectModelContext,
} from "@opensesame/webmcp";
import { createApiClient } from "./api-client";
import { createOpenSesame } from "./sdk-browser";

export type PwaWebMcpConfig = { hostApi: string; issuer: string };

/**
 * The thin shell's WebMCP catalog (ADR 0065): status and health reads plus a
 * sign-in ceremony opener. Signing in itself stays with the human — the tool
 * points at the UI and never starts or completes an auth flow.
 */
export function pwaWebMcpTools(config: PwaWebMcpConfig): WebMcpToolSpec[] {
  const sesame = createOpenSesame({
    issuer: config.issuer,
    clientId: "opensesame-pwa",
  });
  return [
    {
      name: "opensesame_pwa_status",
      description:
        "Identity session status of the OpenSesame client PWA: whether a session exists and whether it is a provisional guest. Never returns tokens.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      execute: async () => {
        const session = await sesame.getSession();
        return {
          signedIn: session !== null,
          anonymous: session?.anonymous ?? null,
          sub: session?.sub ?? null,
        };
      },
    },
    {
      name: "opensesame_pwa_health",
      description:
        "Health of the Host API and the optional local daemon as seen from this PWA.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      execute: async () => {
        const client = createApiClient({ baseUrl: config.hostApi });
        const health = await client.health();
        const daemon = await client.probeDaemon();
        return {
          hostApi: config.hostApi,
          hostOk: health.ok,
          daemonAvailable: daemon.available,
        };
      },
    },
    {
      name: "opensesame_open_sign_in",
      description:
        "Bring the sign-in controls into focus so the human can sign in. Never starts or completes authentication.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      execute: async () => {
        if ((await sesame.getSession()) !== null) {
          return { status: "already_signed_in" };
        }
        const button = document.querySelector<HTMLButtonElement>(
          '[data-webmcp="sign-in"]',
        );
        button?.focus();
        return { status: "ceremony_opened", location: "/" };
      },
    },
  ];
}

export function registerPwaWebMcp(config: PwaWebMcpConfig): Unregister {
  const registrar = createWebMcpRegistrar(detectModelContext(), {
    appId: "opensesame-pwa",
  });
  return registrar.register(pwaWebMcpTools(config));
}
