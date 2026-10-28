// @vitest-environment node
/**
 * Every connector, end to end (ADR 0147): the page's own builders create the
 * connector through the real relay, Connect (emulated, schema-strict) runs a
 * real authorization-code exchange against a strict provider emulator for a
 * person, and the relay's token proof acquires that person's token and gets
 * the service's own verify call to answer yes when its destination is bound,
 * without the token ever reaching the page. Unbound verification hosts are
 * explicitly refused while token acquisition remains available.
 *
 * `CONNECT_CONFORMANCE_OUT=<file>` writes the per-connector results as
 * evidence.
 */
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { applyConnectCallbackBase } from "@opensesame/app-core/lib/connect-callback.js";
import type { DraftState } from "@opensesame/app-core/lib/connect-draft.js";
import { toConnectorDraft } from "@opensesame/app-core/lib/connect-draft.js";
import {
  type ConnectMethodKind,
  type ConnectPlan,
  connectPlans,
  isConnectable,
} from "@opensesame/app-core/lib/connect-plan.js";
import {
  authorizeConnectorAs,
  checkConnectorToken,
  createConfiguredConnector,
} from "@opensesame/app-core/lib/vercel-connect-manage.js";
import { setVercelConnectAuth } from "@opensesame/app-core/lib/vercel-connect.js";
import {
  type JsonValue,
  isJsonObject,
  readString,
} from "@opensesame/os-domain";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { handleCallback } from "../../../server/callback.mjs";
import { VERIFY_TARGETS } from "../../../server/connect-verify-targets.generated.mjs";
import {
  resolveTarget,
  verifyWithToken,
} from "../../../server/connect-verify.mjs";
import { handleManage } from "../../../server/manage.mjs";
import { assertTokenProof } from "./conformance-proof.js";
import { CONNECT_ORIGIN, ConnectEmulator } from "./connect-emulator.js";
import { ProviderEmulator, type ProviderProfile } from "./provider-emulator.js";
import { scenario } from "./scenario.js";

const RELAY = "https://relay.test";
const APP = "http://localhost";
const KEY = `${"m".repeat(32)}-conformance-manage-key`;
const PERSON = { type: "user" as const, id: "prn_conformance" };

type Row = {
  service: string;
  method: ConnectMethodKind;
  outcome: string;
  verified: number | null;
  account: string;
};
const rows: Row[] = [];

let connect: ConnectEmulator;
let provider: ProviderEmulator;

async function route(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const request = new Request(input, init);
  const url = new URL(request.url);
  // api.vercel.com is Connect and, for the Vercel connector, the provider.
  if (
    url.origin === CONNECT_ORIGIN &&
    /^\/v[12]\/connect\//.test(url.pathname)
  ) {
    return connect.handle(request);
  }
  if (url.origin === APP) return new Response("app");
  if (url.origin === RELAY) {
    const outcome =
      url.pathname === "/api/connect/callback"
        ? handleCallback(`${url.pathname}${url.search}`, RELAY)
        : await handleManage({
            method: request.method,
            path: url.pathname,
            origin: "http://localhost:5180",
            authorization: request.headers.get("authorization") ?? "",
            requestHost: RELAY,
            body: request.method === "GET" ? {} : await request.json(),
          });
    return new Response(outcome.body || null, {
      status: outcome.status,
      headers: outcome.headers,
    });
  }
  return provider.handle(request);
}

/** A person's browser: follow redirects until the app is back in front. */
async function browse(start: string): Promise<string> {
  let next = start;
  for (let hop = 0; hop < 12; hop += 1) {
    if (new URL(next).origin === APP) return next;
    const reply = await route(next, { redirect: "manual" });
    const location = reply.headers.get("location");
    if (!location)
      throw new Error(
        `stopped at ${next}: ${reply.status} ${await reply.text()}`,
      );
    next = new URL(location, next).toString();
  }
  throw new Error("redirect loop");
}

beforeAll(() => {
  vi.stubGlobal("fetch", route);
  process.env.VERCEL_TOKEN = "vercel_operator_token";
  process.env.OPENSESAME_CONNECT_MANAGE_KEY = KEY;
  applyConnectCallbackBase(RELAY);
  setVercelConnectAuth({ token: "", manageKey: KEY });
});

afterAll(() => {
  vi.unstubAllGlobals();
  setVercelConnectAuth(null);
  applyConnectCallbackBase(undefined);
  const out = process.env.CONNECT_CONFORMANCE_OUT;
  if (out) writeFileSync(out, `${JSON.stringify(rows, null, 2)}\n`);
});

/** Managed rows Vercel runs with its own app and publishes nothing about. */
const VERCEL_ONLY = new Set(["linq", "snowflake"]);

const cases = connectPlans()
  .filter(isConnectable)
  .flatMap((plan) =>
    plan.methods.map(
      (method) => [`${plan.id} · ${method.kind}`, plan, method.kind] as const,
    ),
  )
  .filter(
    ([, plan, kind]) => !(kind === "managed" && VERCEL_ONLY.has(plan.id)),
  );

describe("every connector acquires a person's token", () => {
  it.each(cases)("%s", async (_label, plan, kind) => {
    const { profile, state } = scenario(plan, kind);
    provider = new ProviderEmulator(profile);
    connect = new ConnectEmulator(plan, (request) => provider.handle(request));
    const callback = [`${CONNECT_ORIGIN}/v1/connect/callback`];
    if (state.method === "oauth" && state.oauth.clientId) {
      provider.registerByHand({
        clientId: state.oauth.clientId,
        clientSecret: state.oauth.clientSecret,
        tokenAuth: state.oauth.tokenAuth,
        redirectUris: callback,
      });
    }
    if (state.method === "mcp" && state.mcpClientId) {
      provider.registerByHand({
        clientId: state.mcpClientId,
        clientSecret: state.mcpClientSecret,
        tokenAuth: "client_secret_post",
        redirectUris: callback,
      });
    }
    const connection = await createConfiguredConnector(
      plan,
      toConnectorDraft(state),
    );
    expect(connect.refusals).toEqual([]);

    const { authorizationUrl } = await authorizeConnectorAs(
      connection.connectionId,
      PERSON,
      state.oauth.scopes,
    );
    let landing: string;
    if (authorizationUrl.includes("/v1/connect/key-entry")) {
      const key = provider.issueApiKey();
      const entry = await route(authorizationUrl, {
        method: "POST",
        body: JSON.stringify({ key }),
        headers: { "content-type": "application/json" },
      });
      const entered: JsonValue = await entry.json();
      landing = await browse(
        (isJsonObject(entered) ? readString(entered.location) : null) ?? "",
      );
    } else {
      landing = await browse(authorizationUrl);
    }
    expect(landing).toContain(
      `connection=${encodeURIComponent(connection.connectionId)}`,
    );

    const providerCallsBeforeCheck = [...provider.log];
    const check = await checkConnectorToken(connection.connectionId, PERSON);
    const issued = [...provider.issued, ...provider.apiKeys];
    // A truncated SHA-256 fingerprint, only to recognise the same token
    // without logging it — not password storage or verification.
    const fingerprints = issued.map((token) =>
      createHash("sha256").update(token).digest("hex").slice(0, 12),
    );
    expect(fingerprints).toContain(check.fingerprint);
    assertTokenProof({
      plan,
      kind,
      profile,
      provider,
      providerCallsBeforeCheck,
      check,
    });
    rows.push({
      service: plan.id,
      method: kind,
      outcome: "token acquired",
      verified: check.verified?.status ?? null,
      account: check.verified?.account ?? "",
    });
  });

  it("leaves no connectable service without a way to a token", () => {
    const proven = new Set(rows.map((row) => row.service));
    const unproven = connectPlans()
      .filter(isConnectable)
      .map((plan) => plan.id)
      .filter((id) => !proven.has(id));
    const managedOnly = connectPlans().filter(
      (plan) =>
        VERCEL_ONLY.has(plan.id) &&
        plan.methods.every(({ kind }) => kind === "managed"),
    );
    expect(unproven.sort()).toEqual(managedOnly.map(({ id }) => id).sort());
  });
});

describe("negative controls: a wrong setting fails the way the provider would", () => {
  const found = connectPlans().find((row) => row.id === "zoom");
  if (!found) throw new Error("zoom plan missing");
  const plan: ConnectPlan = found;

  async function attempt(
    mutate: (state: DraftState, profile: ProviderProfile) => DraftState,
  ) {
    const built = scenario(plan, "oauth");
    const state = mutate(built.state, built.profile);
    provider = new ProviderEmulator(built.profile);
    connect = new ConnectEmulator(plan, (request) => provider.handle(request));
    provider.registerByHand({
      clientId: "client-id",
      clientSecret: "client-secret",
      tokenAuth: built.state.oauth.tokenAuth,
      redirectUris: [`${CONNECT_ORIGIN}/v1/connect/callback`],
    });
    const connection = await createConfiguredConnector(
      plan,
      toConnectorDraft(state),
    );
    const { authorizationUrl } = await authorizeConnectorAs(
      connection.connectionId,
      PERSON,
      state.oauth.scopes,
    );
    await browse(authorizationUrl);
    return checkConnectorToken(connection.connectionId, PERSON);
  }

  it("the wrong client authentication never gets a token", async () => {
    await expect(
      attempt((state) => ({
        ...state,
        oauth: {
          ...state.oauth,
          tokenAuth:
            state.oauth.tokenAuth === "client_secret_basic"
              ? "client_secret_post"
              : "client_secret_basic",
        },
      })),
    ).rejects.toThrow(/token_exchange_failed|invalid_client/);
  });

  it("the wrong client secret never gets a token", async () => {
    await expect(
      attempt((state) => ({
        ...state,
        oauth: { ...state.oauth, clientSecret: "not-the-secret" },
      })),
    ).rejects.toThrow(/token_exchange_failed|bad secret/);
  });

  it("dropping PKCE where the provider requires it is refused at authorize", async () => {
    await expect(
      attempt((state, profile) => {
        profile.pkce = "required";
        return { ...state, oauth: { ...state.oauth, pkce: "none" } };
      }),
    ).rejects.toThrow(/code_challenge required/);
  });

  it("a token the service does not accept is reported as not verified", async () => {
    const check = await attempt((state, profile) => {
      if (profile.verify)
        profile.verify = { ...profile.verify, scheme: "Token" };
      return state;
    });
    expect(check.verified).toMatchObject({ status: 401, ok: false });
  });
});

it("preserves Neon organization authority through the actual connector create body", async () => {
  const plan = connectPlans().find((item) => item.id === "neon");
  assertPlan(plan);
  const { profile, state } = scenario(plan, "api-key");
  provider = new ProviderEmulator(profile);
  connect = new ConnectEmulator(plan, (request) => provider.handle(request));
  const configured = await createConfiguredConnector(
    plan,
    toConnectorDraft(state),
  );
  const held = connect.connectors.get(configured.connectionId);
  expect(held?.data.serviceUrls).toEqual([
    "https://console.neon.tech/api/v2",
    "https://console.neon.tech/api/v2/projects?limit=20&org_id=acme.example",
  ]);
  const target = VERIFY_TARGETS.neon.apiKey;
  if (!target) throw new Error("Missing Neon verification target.");
  expect(resolveTarget(target, held)?.url).toBe(
    "https://console.neon.tech/api/v2/projects?limit=20&org_id=acme.example",
  );
  for (const serviceUrls of [
    [],
    ["https://attacker.example/api/v2/projects?limit=20&org_id=acme.example"],
  ]) {
    const unresolved = resolveTarget(target, { data: { serviceUrls } });
    expect(unresolved.url).toContain("{org_id}");
    expect(
      await verifyWithToken(unresolved, "never-sent-token", () => {
        throw new Error(
          "An unresolved organization must not send a credential.",
        );
      }),
    ).toBeNull();
  }
});

describe("create refusals stay generic on the wire", () => {
  it("records schema detail in refusals, never in the response", async () => {
    const plan = connectPlans().find(isConnectable);
    assertPlan(plan);
    const emulator = new ConnectEmulator(plan, () =>
      Promise.resolve(new Response("{}")),
    );
    const reply = await emulator.handle(
      new Request(`${CONNECT_ORIGIN}/v1/connect/connectors`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ bogus: "<script>" }),
      }),
    );
    expect(reply.status).toBe(400);
    expect(reply.headers.get("content-type")).toBe("application/json");
    expect(reply.headers.get("x-content-type-options")).toBe("nosniff");
    const body = await reply.text();
    expect(body).toContain(
      "Connector create body was refused by the Connect schema.",
    );
    expect(body).not.toContain("<script>");
    expect(emulator.refusals).toHaveLength(1);
    expect(emulator.refusals[0]).not.toBe(body);
  });
});

function assertPlan(
  plan: ConnectPlan | undefined,
): asserts plan is ConnectPlan {
  if (!plan) throw new Error("conformance cases are empty");
}
