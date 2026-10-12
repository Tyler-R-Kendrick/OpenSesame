/**
 * The parts a `harness()` is assembled from: the fixed clock and the ports the
 * broker reads, a signer that can make proofs good and bad, and one builder per
 * thing a test does with a broker (issue a root, exchange a key, make a call).
 * `harness.test-support.ts` is the face the tests use; this file is what is
 * behind it, split out so no builder grows into the whole of the harness.
 */
import { name } from "@gdp-ts/core";
import type {
  BoundaryObject,
  BoundaryValue,
  JsonObject,
} from "@opensesame/os-domain";
import { randomString, sha256Base64Url } from "@opensesame/sdk-browser";
import {
  type JWK,
  SignJWT,
  calculateJwkThumbprint,
  exportJWK,
  generateKeyPair,
} from "jose";
import { proveModelGrantApproved } from "../proofs/model-grant-approval.js";
import { type IssuedRoot, ModelKeyBroker } from "./broker.js";
import type { ExchangeContext } from "./exchange.js";
import { type ModelGrantDraft, modelGrantDigest } from "./root.js";
import {
  type BrokerPolicy,
  DEFAULT_POLICY,
  type ModelKeyEvent,
  type ProviderTarget,
} from "./types.js";
import { ACCESS_TOKEN_TYPE, TOKEN_EXCHANGE_GRANT } from "./vocabulary.js";

export const T0 = Date.UTC(2026, 9, 11, 12, 0, 0);
export const ENDPOINT = "https://vault.example.test/OpenSesame/models/token";

export const OPENAI: ProviderTarget = {
  providerId: "openai",
  protocol: "openai_chat",
  baseUrl: "https://api.openai.com/v1",
};
export const ANTHROPIC: ProviderTarget = {
  providerId: "anthropic",
  protocol: "anthropic_messages",
  baseUrl: "https://api.anthropic.com/v1",
};
export const GEMINI: ProviderTarget = {
  providerId: "gemini",
  protocol: "gemini_generate_content",
  baseUrl: "https://generativelanguage.googleapis.com/v1beta",
};
export const OPENROUTER: ProviderTarget = {
  providerId: "openrouter",
  protocol: "openai_chat",
  baseUrl: "https://openrouter.ai/api/v1",
};
const TARGETS = [OPENAI, ANTHROPIC, GEMINI, OPENROUTER];

export type Signer = Readonly<{
  privateKey: CryptoKey;
  jwk: JWK;
  jkt: string;
}>;

export async function newSigner(): Promise<Signer> {
  const { publicKey, privateKey } = await generateKeyPair("ES256", {
    extractable: true,
  });
  const exported = await exportJWK(publicKey);
  const jwk = {
    kty: exported.kty,
    crv: exported.crv,
    x: exported.x,
    y: exported.y,
  };
  return { privateKey, jwk, jkt: await calculateJwkThumbprint(jwk, "sha256") };
}

export type ProofOptions = Readonly<{
  htm: string;
  htu: string;
  token: string;
  now: number;
  jti?: string;
  iat?: number;
  ath?: string | null;
  typ?: string;
  header?: JsonObject;
  claims?: JsonObject;
}>;

/** A proof for `signer`; every field a test may want to break is an option. */
export async function makeProof(
  signer: Signer,
  options: ProofOptions,
): Promise<string> {
  const ath =
    options.ath === undefined
      ? await sha256Base64Url(options.token)
      : options.ath;
  const claims: JsonObject = {
    jti: options.jti ?? randomString(16),
    htm: options.htm,
    htu: options.htu,
    iat: options.iat ?? Math.floor(options.now / 1000),
  };
  if (ath !== null) claims.ath = ath;
  Object.assign(claims, options.claims);
  return new SignJWT(claims)
    .setProtectedHeader({
      alg: "ES256",
      typ: options.typ ?? "dpop+jwt",
      jwk: signer.jwk,
      ...options.header,
    })
    .sign(signer.privateKey);
}

/** The only thing a root takes from its signer: the thumbprint it is bound to. */
export type Bindable = Pick<Signer, "jkt">;

export function baseDraft(
  signer: Bindable | null,
  overrides: Partial<ModelGrantDraft> = {},
): ModelGrantDraft {
  return {
    issuerPrincipalId: "person-1",
    organizationId: "org-1",
    clientId: "app-1",
    connectionId: "conn-openai",
    resource: OPENAI.baseUrl,
    actions: ["model.invoke", "model.list"],
    models: ["gpt-4o", "gpt-4o-mini"],
    budget: {
      requests: 100,
      input_tokens: 100_000,
      output_tokens: 50_000,
      max_output_tokens: 4096,
    },
    lifetimeSeconds: 2 * 60 * 60,
    maximumDelegationDepth: 2,
    dpopJkt: signer?.jkt ?? null,
    ...overrides,
  };
}

/** Hold the nth hash until `hold` settles: a way to stop an exchange in the middle. */
export type Gate = {
  holdOn: number;
  hold: Promise<void> | null;
  calls: number;
};

/** What a test may vary about an exchange besides the key it presents. */
export type ExchangeOptions = {
  signer?: Signer | null;
  clientId?: string;
  extra?: Record<string, string>;
  proof?: string | null;
};

/** What a test may vary about a call besides the key it presents. */
export type CallRequest = {
  operation?: "invoke" | "list";
  method?: string;
  path?: string;
  body?: BoundaryValue;
  resource?: string;
  clientId?: string;
  proof?: string | null;
  target?: ProviderTarget;
};

/** The moment the broker sees; a test moves it by assigning `now`. */
export type Clock = { now: number };

/** A saved connection as the broker's port reports it, before it has an id. */
export type SavedConnection = { providerId: string; verified: boolean };

/** The broker and every dial a test may turn on the ports behind it. */
export function brokerRig(policy: Partial<BrokerPolicy> = {}) {
  const clock: Clock = { now: T0 };
  const events: ModelKeyEvent[] = [];
  const connections = new Map<string, SavedConnection>([
    ["conn-openai", { providerId: "openai", verified: true }],
    ["conn-anthropic", { providerId: "anthropic", verified: true }],
    ["conn-gemini", { providerId: "gemini", verified: true }],
    ["conn-openrouter", { providerId: "openrouter", verified: true }],
    ["conn-other-openai", { providerId: "openai", verified: true }],
  ]);
  const sink = { fail: false };
  /** Run something at the nth moment the broker reads the clock: a way to interleave. */
  const clockHooks: ((call: number) => void)[] = [];
  let clockReads = 0;
  /** Hold the nth hash until `release` is called: a way to stop an exchange in the middle. */
  const gate: Gate = {
    holdOn: 0,
    hold: null,
    calls: 0,
  };
  const broker = new ModelKeyBroker(
    {
      now: () => {
        clockReads += 1;
        for (const hook of clockHooks) hook(clockReads);
        return clock.now;
      },
      random: randomString,
      sha256: async (text) => {
        gate.calls += 1;
        if (gate.holdOn === gate.calls && gate.hold) await gate.hold;
        return sha256Base64Url(text);
      },
      providerForResource: (resource) =>
        TARGETS.find((t) => t.baseUrl === resource) ?? null,
      connection: (id) => {
        const found = connections.get(id);
        return found ? { connectionId: id, ...found } : null;
      },
      audit: (event) => {
        if (sink.fail) throw new Error("audit sink down");
        events.push(event);
      },
    },
    { ...DEFAULT_POLICY, ...policy },
  );
  return { broker, clock, events, connections, sink, clockHooks, gate };
}

/** Issue a root key on `broker` the way its owner would: approved, then issued. */
export function rootIssuer(broker: ModelKeyBroker, clock: Clock) {
  return async function root(
    signer: Bindable | null,
    overrides: Partial<ModelGrantDraft> = {},
  ): Promise<IssuedRoot & { draft: ModelGrantDraft }> {
    const draft = baseDraft(signer, overrides);
    const digest = await modelGrantDigest(draft, sha256Base64Url);
    const issued = await name(draft, async (named) => {
      const verdict = await proveModelGrantApproved(
        named,
        {
          approverPrincipalId: draft.issuerPrincipalId,
          method: "passkey",
          authenticatedAt: clock.now - 10_000,
          approvedAt: clock.now - 1_000,
          boundDigest: digest,
        },
        clock.now,
        sha256Base64Url,
      );
      if (!verdict.ok) throw new Error(`approval refused: ${verdict.code}`);
      return broker.issueRoot(named, verdict.proof);
    });
    return { ...issued, draft };
  };
}

/** The parameters of an exchange; `details` is the one `model_access` detail. */
export function exchangeParams(
  token: string,
  details: BoundaryObject | null,
  extra: Record<string, string> = {},
) {
  const form: JsonObject = {
    grant_type: TOKEN_EXCHANGE_GRANT,
    subject_token: token,
    subject_token_type: ACCESS_TOKEN_TYPE,
  };
  if (details) {
    form.authorization_details = JSON.stringify([
      { type: "model_access", ...details },
    ]);
  }
  return { ...form, ...extra };
}

/** Exchange a key on `broker`, signing the proof unless the test says otherwise. */
export function exchanger(broker: ModelKeyBroker, clock: Clock) {
  return async function exchange(
    token: string,
    details: BoundaryObject | null,
    options: ExchangeOptions = {},
  ) {
    const signer = options.signer ?? null;
    let dpopProof: string | undefined;
    if (options.proof === undefined) {
      if (signer) {
        dpopProof = await makeProof(signer, {
          htm: "POST",
          htu: ENDPOINT,
          token,
          now: clock.now,
        });
      }
    } else if (options.proof !== null) {
      dpopProof = options.proof;
    }
    const base = { clientId: options.clientId ?? "app-1", endpoint: ENDPOINT };
    const context: ExchangeContext =
      dpopProof === undefined ? base : { ...base, dpopProof };
    return broker.exchange(
      exchangeParams(token, details, options.extra),
      context,
    );
  };
}

/** Authorize a call on `broker`, signing the proof unless the test says otherwise. */
export function caller(broker: ModelKeyBroker, clock: Clock) {
  return async function call(
    token: string,
    signer: Signer | null,
    request: CallRequest,
  ) {
    const target = request.target ?? OPENAI;
    const operation = request.operation ?? "invoke";
    const method = request.method ?? (operation === "list" ? "GET" : "POST");
    const path =
      request.path ?? (operation === "list" ? "/models" : "/chat/completions");
    const url = `${target.baseUrl}${path}`;
    const proof =
      request.proof !== undefined
        ? request.proof
        : signer
          ? await makeProof(signer, {
              htm: method,
              htu: url,
              token,
              now: clock.now,
            })
          : null;
    const base = { token, clientId: request.clientId ?? "app-1" };
    return broker.authorize(
      proof === null ? base : { ...base, dpopProof: proof },
      {
        operation,
        method,
        path,
        body: request.body,
        resource: request.resource ?? target.baseUrl,
      },
    );
  };
}

/** A chat completion that is in policy, unless `overrides` says it is not. */
export const chat = (overrides: BoundaryObject = {}): BoundaryObject => ({
  model: "gpt-4o",
  messages: [{ role: "user", content: "hello" }],
  max_tokens: 100,
  ...overrides,
});
