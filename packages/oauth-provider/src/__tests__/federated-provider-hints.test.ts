import { createHash, randomBytes } from "node:crypto";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  type BoundaryValue,
  type JsonObject,
  overlapCast,
} from "@opensesame/os-domain";
import type { AdapterPayload } from "oidc-provider";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMemoryAdapterConstructor } from "../adapter/memory-adapter.js";
import type { OidcAdapterConstructor } from "../adapter/types.js";
import { createOpenSesameProvider } from "../create-provider.js";
import { MemoryPairwiseSubjectStore } from "../pairwise/store.js";

const CLIENT_ID = "rp-public";
const REDIRECT_URI = "http://127.0.0.1:4999/cb";

let server: Server;
let issuer: string;
let adapterCtor: OidcAdapterConstructor;
let handler: ((req: BoundaryValue, res: BoundaryValue) => void) | undefined;

function challengeFor(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

/** Issue an authorize request and return the persisted interaction params. */
async function authorizeAndReadInteractionParams(
  extra: Record<string, string>,
): Promise<JsonObject> {
  const verifier = randomBytes(32).toString("base64url");
  const url = new URL("/auth", issuer);
  const query: Record<string, string> = {
    client_id: CLIENT_ID,
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    scope: "openid",
    state: randomBytes(8).toString("hex"),
    nonce: randomBytes(8).toString("hex"),
    code_challenge: challengeFor(verifier),
    code_challenge_method: "S256",
    ...extra,
  };
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, value);
  }

  const response = await fetch(url, { redirect: "manual" });
  const location = response.headers.get("location") ?? "";
  // No session exists, so the login prompt must be raised and an interaction
  // persisted — that redirect is what carries params to the login page.
  expect(response.status, `unexpected body: ${await response.text()}`).toBe(
    303,
  );
  const uid = /\/interaction\/([^/?#]+)/.exec(location)?.[1];
  expect(uid, `no interaction uid in ${location}`).toBeDefined();

  const stored: AdapterPayload | undefined = await new adapterCtor(
    "Interaction",
  ).find(String(uid));
  expect(stored).toBeDefined();
  const params: JsonObject = overlapCast(stored?.params);
  return params;
}

beforeAll(async () => {
  server = createServer((req, res) => {
    handler?.(overlapCast(req), overlapCast(res));
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address: AddressInfo = overlapCast(server.address());
  issuer = `http://127.0.0.1:${address.port}`;

  adapterCtor = createMemoryAdapterConstructor();
  const bundle = createOpenSesameProvider({
    issuer,
    processEnv: {},
    adapter: adapterCtor,
    pairwiseStore: new MemoryPairwiseSubjectStore(),
    clients: [
      {
        client_id: CLIENT_ID,
        token_endpoint_auth_method: "none",
        redirect_uris: [REDIRECT_URI],
        grant_types: ["authorization_code"],
        response_types: ["code"],
        subject_type: "pairwise",
      },
    ],
  });
  handler = bundle.provider.callback();
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
});

describe("federated provider hint passthrough", () => {
  it("registers both hint params on the provider configuration", () => {
    const bundle = createOpenSesameProvider({ issuer, processEnv: {} });
    expect(Object.keys(overlapCast(bundle.configuration.extraParams))).toEqual([
      "kc_idp_hint",
      "login_hint_provider",
    ]);
  });

  it("surfaces kc_idp_hint in the interaction details params", async () => {
    const params = await authorizeAndReadInteractionParams({
      kc_idp_hint: "shoo",
    });
    expect(params.kc_idp_hint).toBe("shoo");
  });

  it("surfaces login_hint_provider in the interaction details params", async () => {
    const params = await authorizeAndReadInteractionParams({
      login_hint_provider: "shoo",
    });
    expect(params.login_hint_provider).toBe("shoo");
  });

  it("carries both hints together as the browser SDK sends them", async () => {
    const params = await authorizeAndReadInteractionParams({
      kc_idp_hint: "shoo",
      login_hint_provider: "shoo",
    });
    expect(params.kc_idp_hint).toBe("shoo");
    expect(params.login_hint_provider).toBe("shoo");
  });

  it("omits the hint keys entirely when the request carries none", async () => {
    const params = await authorizeAndReadInteractionParams({});
    expect(params).not.toHaveProperty("kc_idp_hint");
    expect(params).not.toHaveProperty("login_hint_provider");
  });

  it("drops an unusable hint instead of failing the request or passing it on", async () => {
    const params = await authorizeAndReadInteractionParams({
      kc_idp_hint: '"><script>alert(1)</script>',
      login_hint_provider: "a".repeat(65),
    });
    expect(params).not.toHaveProperty("kc_idp_hint");
    expect(params).not.toHaveProperty("login_hint_provider");
  });
});
