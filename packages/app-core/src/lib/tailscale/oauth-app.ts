import type { BoundaryValue } from "@opensesame/os-domain";
/** Tailscale's documented user-owned, single-use device provisioning protocol. */
import { randomString } from "@opensesame/sdk-browser";
import { z } from "zod";
import type { NativeOAuthBrowserPort } from "../native-oauth-browser-port.js";
import { parseNativeOAuthCallback } from "../native-oauth-session.js";
import {
  createBackendHttp,
  secretBackendUrl,
} from "../secret-backends/http.js";
import type { TailscaleTransport } from "./transport.js";

export const TAILSCALE_PROVISION_SCOPE = "auth_keys:create:once";
const NodeAttributesSchema = z
  .array(
    z
      .string()
      .max(128)
      .regex(/^custom:[A-Za-z0-9][A-Za-z0-9:_.-]*$/),
  )
  .max(64)
  .refine((values) => new Set(values).size === values.length);
const AppSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/),
  name: z.string().min(1).max(256),
  clientSecret: z.string().min(1).max(16384),
  redirectURIs: z.array(z.string().url()).min(1),
  scopes: z.array(z.string()),
  allowedNodeAttributes: NodeAttributesSchema.optional(),
});
export type TailscaleApp = z.infer<typeof AppSchema>;
export type TailscaleAppConfiguration = {
  apiBase: string;
  tailnet: string;
  redirectUri: string;
  name: string;
  allowedNodeAttributes?: string[];
};
export type TailscaleProvisionedKey = Readonly<{
  key: string;
  expiresAt: number;
  singleUse: true;
}>;

export function tailscaleAppConfiguration(input: TailscaleAppConfiguration) {
  const apiBase = secretBackendUrl(input.apiBase).href;
  const redirectUri = secretBackendUrl(input.redirectUri);
  // A callback path is exact, unlike a base URL: retain its original slash.
  redirectUri.pathname = new URL(input.redirectUri).pathname;
  if (
    input.tailnet === "." ||
    input.tailnet === ".." ||
    !input.tailnet ||
    input.tailnet.length > 256 ||
    /[/?#\\]/.test(input.tailnet)
  )
    throw new Error("Enter a tailnet name or - for the token's tailnet.");
  if (!input.name.trim() || input.name.length > 128)
    throw new Error("Enter an app name of at most 128 characters.");
  NodeAttributesSchema.parse(input.allowedNodeAttributes ?? []);
  return { ...input, apiBase, redirectUri: redirectUri.href };
}

function assertApp(app: TailscaleApp, config: TailscaleAppConfiguration): void {
  AppSchema.parse(app);
  if (
    app.scopes.length !== 1 ||
    app.scopes[0] !== TAILSCALE_PROVISION_SCOPE ||
    app.redirectURIs.length !== 1 ||
    app.redirectURIs[0] !== config.redirectUri ||
    JSON.stringify([...(app.allowedNodeAttributes ?? [])].sort()) !==
      JSON.stringify([...(config.allowedNodeAttributes ?? [])].sort())
  )
    throw new Error(
      "The Tailscale app has different callback, permissions or node attributes.",
    );
}

/** Unique operator/session display name; Tailscale generates the actual client id. */
export function tailscaleAppName(): string {
  return `OpenSesame ${randomString(12)}`;
}

function context(
  input: TailscaleAppConfiguration,
  transport: TailscaleTransport,
) {
  const config = tailscaleAppConfiguration(input);
  const http = createBackendHttp(config.apiBase, async (url, init) => {
    transport.assertCurrent();
    const response = await transport.fetch(url, init);
    transport.assertCurrent();
    return response;
  });
  const appPath = `api/v2/tailnet/${encodeURIComponent(config.tailnet)}/oauth-apps`;
  return { config, http, transport, appPath };
}
function adminHeaders(token: string) {
  if (!token || token.length > 16384 || /[\r\n:]/.test(token))
    throw new Error("Enter an admin API access token.");
  return {
    Authorization: `Basic ${btoa(`${token}:`)}`,
    "Content-Type": "application/json",
  };
}
type ClientContext = ReturnType<typeof context>;
async function registerApp(
  ctx: ClientContext,

  adminToken: string,
  retain: (app: TailscaleApp) => Promise<void>,
  signal?: AbortSignal,
): Promise<TailscaleApp> {
  const { config, http, transport, appPath } = ctx;
  const raw = await http(appPath, {
    method: "POST",
    headers: adminHeaders(adminToken),
    body: JSON.stringify({
      name: config.name.trim(),
      redirectUris: [config.redirectUri],
      scopes: [TAILSCALE_PROVISION_SCOPE],
      allowedNodeAttributes: config.allowedNodeAttributes?.length
        ? config.allowedNodeAttributes
        : undefined,
    }),
    signal,
  });
  const app = AppSchema.parse(raw);
  assertApp(app, config);
  transport.assertCurrent();
  // The API reveals this secret only once. Persist before the verification GET.
  await retain(app);
  transport.assertCurrent();
  return app;
}
async function verifyApp(
  ctx: ClientContext,
  app: TailscaleApp,
  adminToken: string,
  signal?: AbortSignal,
) {
  const { config, http, transport, appPath } = ctx;
  assertApp(app, config);
  const raw = await http(`${appPath}/${encodeURIComponent(app.id)}`, {
    headers: adminHeaders(adminToken),
    signal,
  });
  const metadata = AppSchema.omit({ clientSecret: true }).parse(raw);
  if (metadata.id !== app.id || metadata.name !== app.name)
    throw new Error("Tailscale returned a different OAuth app.");
  assertApp({ ...metadata, clientSecret: app.clientSecret }, config);
  transport.assertCurrent();
}
function callbackCode(
  search: string,
  state: string,
  expiresAt: number,
): string {
  // The browser port verifies the callback URL before normalizing its fields.
  const callback = parseNativeOAuthCallback(search);
  if (callback.state !== state || Date.now() >= expiresAt)
    throw new Error(
      "The Tailscale authorization callback is invalid or expired.",
    );
  if (callback.error) throw new Error("Tailscale authorization was declined.");
  if (!callback.code)
    throw new Error("Tailscale did not return an authorization code.");
  return callback.code;
}
async function provisionDevice(
  ctx: ClientContext,

  app: TailscaleApp,
  browser: NativeOAuthBrowserPort,
  signal?: AbortSignal,
): Promise<TailscaleProvisionedKey> {
  const { config, http, transport } = ctx;
  assertApp(app, config);
  transport.assertCurrent();
  if (!browser.authorize || browser.redirectUri !== config.redirectUri)
    throw new Error("Use this deployment's registered browser callback.");
  const state = randomString(32);
  const expiresAt = Date.now() + 10 * 60_000;
  const url = new URL("https://login.tailscale.com/a/oauth_authorize");
  url.search = new URLSearchParams({
    client_id: app.id,
    redirect_uri: config.redirectUri,
    scope: TAILSCALE_PROVISION_SCOPE,
    state,
    response_type: "code",
  }).toString();
  const callback = await browser.authorize(url.href, {
    state,
    expiresAt,
    redirectUri: config.redirectUri,
    signal,
  });
  transport.assertCurrent();
  const code = callbackCode(callback, state, expiresAt);
  const raw = await http("api/v2/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: app.id,
      client_secret: app.clientSecret,
      redirect_uri: config.redirectUri,
    }).toString(),
    signal,
  });
  const token = z
    .object({
      access_token: z.string().min(1).max(16384),
      token_type: z.literal("Bearer"),
      expires_in: z.literal(3600),
    })
    .parse(raw);
  transport.assertCurrent();
  // This token already IS the user-owned auth key. Never exchange it again.
  return Object.freeze({
    key: token.access_token,
    expiresAt: Date.now() + token.expires_in * 1000,
    singleUse: true,
  });
}
export function tailscaleOAuthAppClient(
  input: TailscaleAppConfiguration,
  transport: TailscaleTransport,
) {
  const ctx = context(input, transport);
  return {
    config: ctx.config,
    register: (
      adminToken: string,
      retain: (app: TailscaleApp) => Promise<void>,
      signal?: AbortSignal,
    ) => registerApp(ctx, adminToken, retain, signal),
    verify: (app: TailscaleApp, adminToken: string, signal?: AbortSignal) =>
      verifyApp(ctx, app, adminToken, signal),
    provision: (
      app: TailscaleApp,
      browser: NativeOAuthBrowserPort,
      signal?: AbortSignal,
    ) => provisionDevice(ctx, app, browser, signal),
  };
}

export function parseTailscaleApp(
  raw: BoundaryValue,
  config: TailscaleAppConfiguration,
): TailscaleApp {
  const app = AppSchema.parse(raw);
  assertApp(app, tailscaleAppConfiguration(config));
  return app;
}
