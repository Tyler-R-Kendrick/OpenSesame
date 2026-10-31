/** Independent signed OIDC issuer over real HTTP; no token or JWT verification mock. */
import assert from "node:assert/strict";
import { once } from "node:events";
import { type IncomingMessage, createServer } from "node:http";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { vi } from "vitest";
import { z } from "zod";
import { configureHost } from "../host.js";
import type { PagePort, WebStorage } from "../ports.js";
import { createTestHost } from "../test-host.js";
import { resetAmbientAuthSeams } from "./ambient-auth-seam.js";
import { storePending } from "./federation-pending.js";
import { federationExchangeSeams, federationStartSeams } from "./federation.js";
import { loadSettings, settingsSeams } from "./settings.js";

export type TokenFault =
  | "none"
  | "signature"
  | "nonce"
  | "audience"
  | "issuer"
  | "expired";
const CLIENT = "callback-spa";
const CODE = "one-use-code";
const STATE = "state-original-callback";
const NONCE = "nonce-original-callback";
const VERIFIER = "verifier-original-abcdefghijklmnopqrstuvwxyz0123456789";
const formSchema = z
  .object({
    grant_type: z.literal("authorization_code"),
    code: z.literal(CODE),
    code_verifier: z.literal(VERIFIER),
    client_id: z.literal(CLIENT),
    redirect_uri: z.literal("https://app.example.test/registered-callback"),
  })
  .strict();
type ExchangeForm = z.infer<typeof formSchema>;

function storage(): WebStorage {
  const items = new Map<string, string>();
  return {
    get length() {
      return items.size;
    },
    key: (index) => [...items.keys()][index] ?? null,
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => {
      items.set(key, value);
    },
    removeItem: (key) => {
      items.delete(key);
    },
  };
}
export function callbackHost() {
  let url = new URL(
    "https://app.example.test/?code=one-use-code&state=state-original-callback&keep=1",
  );
  const local = storage();
  const session = storage();
  const lifecycle = new EventTarget();
  const navigate = (href: string | URL) => {
    url = new URL(href, url);
  };
  const unexpected = (): never => {
    throw new Error(
      "This core callback oracle does not perform popup, reload, download or form operations",
    );
  };
  const page: PagePort = {
    get location() {
      return {
        origin: url.origin,
        href: url.href,
        protocol: url.protocol,
        host: url.host,
        hostname: url.hostname,
        pathname: url.pathname,
        search: url.search,
        hash: url.hash,
        assign: navigate,
        replace: navigate,
        reload: unexpected,
      };
    },
    opener: null,
    get isSecureContext() {
      return url.protocol === "https:";
    },
    visibilityState: "visible",
    addEventListener: (...args: Parameters<Window["addEventListener"]>) =>
      lifecycle.addEventListener(...args),
    removeEventListener: (...args: Parameters<Window["removeEventListener"]>) =>
      lifecycle.removeEventListener(...args),
    onVisibilityChange(listener) {
      lifecycle.addEventListener("visibilitychange", listener);
      return () => lifecycle.removeEventListener("visibilitychange", listener);
    },
    open: unexpected,
    close() {
      lifecycle.dispatchEvent(new Event("pagehide"));
    },
    replaceUrl: navigate,
    startDownload: unexpected,
    submitForm: unexpected,
  };
  configureHost(createTestHost({ storage: { local, session }, page }));
  resetAmbientAuthSeams();
  return {
    local,
    session,
    href: () => url.href,
    navigate: (href: string) => {
      url = new URL(href, url);
    },
  };
}
export function holdExchangeLoader() {
  let release = () => {};
  let entered = () => {};
  const arrived = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const load = vi
    .spyOn(federationExchangeSeams, "load")
    .mockImplementation(async () => {
      entered();
      await gate;
      return import("./federation-exchange.js");
    });
  return { release, arrived, load };
}
export function holdStartLoader() {
  let release = () => {};
  let entered = () => {};
  const arrived = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const load = vi
    .spyOn(federationStartSeams, "load")
    .mockImplementation(async () => {
      entered();
      await gate;
      return import("./federation-start.js");
    });
  return { release, arrived, load };
}
function responseControl() {
  let release = () => {};
  let arrived = () => {};
  let current: Promise<void> | null = null;
  return {
    hold() {
      if (current) throw new Error("A provider response is already held");
      const reached = new Promise<void>((resolve) => {
        arrived = resolve;
      });
      current = new Promise<void>((resolve) => {
        release = resolve;
      });
      return { arrived: reached, release };
    },
    async wait() {
      if (current) {
        arrived();
        await current;
        current = null;
      }
    },
    close() {
      release();
    },
  };
}
type IssuerWire = Readonly<{
  token: () => string;
  jwks: string;
  requests: string[];
  forms: ExchangeForm[];
  errors: string[];
  discovery: () => string;
  discoveryWait: () => Promise<void>;
  brokered: boolean;
  accessToken: string;
  adoptionWait: () => Promise<void>;
}>;
async function requestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString();
}
function issuerServer(wire: IssuerWire) {
  const { requests, forms, errors } = wire;
  return createServer((request, response) => {
    const answer = async () => {
      requests.push(`${request.method} ${request.url}`);
      response.setHeader("content-type", "application/json");
      if (
        request.method === "GET" &&
        request.url === "/.well-known/openid-configuration"
      ) {
        assert.equal(request.headers.cookie, undefined);
        await wire.discoveryWait();
        response.end(wire.discovery());
        return;
      }
      if (request.method === "GET" && request.url === "/jwks") {
        response.end(wire.jwks);
        return;
      }
      assert.equal(request.method, "POST");
      assert.equal(request.headers.cookie, undefined);
      const body = await requestBody(request);
      if (request.url === "/v1/principals/federated-session") {
        assert.equal(wire.brokered, true);
        assert.equal(forms.length, 1);
        assert.deepEqual(JSON.parse(body), { accessToken: wire.accessToken });
        await wire.adoptionWait();
        response.end(
          JSON.stringify({
            principalId: "principal-signed-operator",
            accessToken: "adopted-opaque-session",
          }),
        );
        return;
      }
      assert.equal(request.url, "/token");
      const form = formSchema.parse(
        Object.fromEntries(new URLSearchParams(body)),
      );
      forms.push(form);
      assert.deepEqual(form, {
        grant_type: "authorization_code",
        code: CODE,
        code_verifier: VERIFIER,
        client_id: CLIENT,
        redirect_uri: "https://app.example.test/registered-callback",
      });
      assert.equal(forms.length, 1, "One callback cannot exchange twice");
      response.end(
        JSON.stringify({
          id_token: wire.token(),
          access_token: wire.accessToken,
        }),
      );
    };
    answer().catch(() => {
      errors.push("Independent issuer refused a request");
      response.writeHead(400);
      response.end("{}");
    });
  });
}

function configuredIssuerSettings(issuer: string, mode: "public" | "brokered") {
  const settings = {
    ...loadSettings(),
    identityApi: mode === "brokered" ? issuer : "",
    signIn: {
      builtin: true,
      providers: [
        {
          providerId: "custom-oidc",
          protocol: "oidc" as const,
          connectionId: "callback",
          issuer,
          clientId: CLIENT,
          label: "Configured issuer",
          jwksUri: `${issuer}/jwks`,
        },
      ],
    },
  };
  vi.spyOn(settingsSeams, "loadSettings").mockImplementation(() => settings);
  return settings;
}

export async function exchangeIssuer(
  fault: TokenFault = "none",
  mode: "public" | "brokered" = "public",
) {
  const keys = await generateKeyPair("ES256");
  const foreign = await generateKeyPair("ES256");
  const jwk = {
    ...(await exportJWK(keys.publicKey)),
    kid: "exchange-key",
    alg: "ES256",
    use: "sig",
  };
  const requests: string[] = [];
  const forms: ExchangeForm[] = [];
  const errors: string[] = [];
  let token = "";
  const discovery = {
    issuer: "",
    authorization_endpoint: "",
    token_endpoint: "",
    jwks_uri: "",
  };
  const control = responseControl();
  const adoption = responseControl();
  const accessToken = crypto.randomUUID();
  const server = issuerServer({
    token: () => token,
    jwks: JSON.stringify({ keys: [jwk] }),
    requests,
    forms,
    errors,
    discovery: () => JSON.stringify(discovery),
    discoveryWait: () => control.wait(),
    brokered: mode === "brokered",
    accessToken,
    adoptionWait: () => adoption.wait(),
  });
  await once(server.listen(0, "127.0.0.1"), "listening");
  const { port } = z
    .object({ port: z.number().int().positive() })
    .parse(server.address());
  const issuer = `http://127.0.0.1:${port}`;
  Object.assign(discovery, {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    jwks_uri: `${issuer}/jwks`,
  });
  const now = Math.floor(Date.now() / 1000);
  token = await new SignJWT({
    nonce: fault === "nonce" ? "foreign-nonce" : NONCE,
    name: "Signed operator",
  })
    .setProtectedHeader({ alg: "ES256", kid: jwk.kid, typ: "JWT" })
    .setIssuer(fault === "issuer" ? "https://foreign.example" : issuer)
    .setSubject("signed-operator")
    .setAudience(fault === "audience" ? "foreign-spa" : CLIENT)
    .setIssuedAt(now)
    .setExpirationTime(fault === "expired" ? now - 3600 : now + 600)
    .sign(fault === "signature" ? foreign.privateKey : keys.privateKey);
  const settings = configuredIssuerSettings(issuer, mode);
  storePending({
    upstreamId: "identity:callback",
    issuer,
    state: STATE,
    nonce: NONCE,
    verifier: VERIFIER,
    tokenEndpoint: `${issuer}/token`,
    jwksUri: `${issuer}/jwks`,
    scope: "openid profile",
    clientId: CLIENT,
    redirectUri: "https://app.example.test/registered-callback",
    returnTo: "/vault?keep=1",
  });
  return {
    issuer,
    discovery,
    holdDiscovery: () => control.hold(),
    holdAdoption: () => adoption.hold(),
    accessToken,
    requests,
    forms,
    errors,
    settings,
    token,
    close: async () => {
      control.close();
      adoption.close();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
