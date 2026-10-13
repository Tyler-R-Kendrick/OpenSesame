/**
 * A certificate authority in a function, for the ACME driver's tests: it holds
 * a request to RFC 8555's rules (a signature that verifies under the account
 * key, a nonce used once, the URL signed is the URL asked for) and answers the
 * way Let's Encrypt does, replay nonce on every reply. What it checks is the
 * same thing a real CA would, so a request that passes here is well formed.
 */
import { createHash, createPublicKey, verify } from "node:crypto";
import type { BoundaryValue } from "@opensesame/os-domain";
import { vi } from "vitest";
import { csrSignatureHolds, parseCsr } from "./native-acme-der.test-support.js";
import type {
  AcmePayload,
  Extra,
  FakeAcmeOptions,
  Jwk,
  OrderBody,
  ProtectedHeader,
} from "./native-acme-fake.types.test-support.js";

export type { FakeAcmeOptions } from "./native-acme-fake.types.test-support.js";

export const BASE = "https://acme-staging-v02.api.letsencrypt.org";
export const PEM_CHAIN =
  "-----BEGIN CERTIFICATE-----\nMIIBleaf\n-----END CERTIFICATE-----\n-----BEGIN CERTIFICATE-----\nMIIBroot\n-----END CERTIFICATE-----\n";
/** The detail a real CA writes; no test should ever see it in a message. */
export const CA_WORDS = "DETAIL-THE-CA-WROTE: do not repeat me";

export type FakeCall = {
  method: string;
  url: string;
  payload: AcmePayload | null;
  protectedHeader: ProtectedHeader | null;
  init: RequestInit | undefined;
};
type Order = {
  url: string;
  names: string[];
  state: string;
  polls: number;
  authzs: string[];
};
type Authz = { order: Order; name: string; wildcard: boolean; token: string };
type Signed = {
  nonce: string;
  header: ProtectedHeader;
  payload: AcmePayload | null;
  jwk: Jwk | undefined;
  signed: boolean;
};

export function jwkThumbprint(jwk: Jwk): string {
  return createHash("sha256")
    .update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y }))
    .digest("base64url");
}

/** What the CA expects a client to publish for a token, computed apart from the driver. */
export function expectedTxt(token: string, jwk: Jwk): string {
  return createHash("sha256")
    .update(`${token}.${jwkThumbprint(jwk)}`)
    .digest("base64url");
}

class FakeCa {
  calls: FakeCall[] = [];
  csrs: { names: string[]; spki: Uint8Array; verified: boolean }[] = [];
  accounts = new Map<string, { id: number; jwk: Jwk }>();
  orders = new Map<string, Order>();
  authzs = new Map<string, Authz>();
  private issued = new Set<string>();
  private answered = new Set<string>();
  private counter = 0;
  private stale: number;

  constructor(private options: FakeAcmeOptions) {
    this.stale = options.staleNonceOnce ? 1 : 0;
  }

  private mint(): string {
    this.counter += 1;
    const nonce = `nonce-${this.counter}-abcdefghij`;
    this.issued.add(nonce);
    return nonce;
  }

  private respond(body: BoundaryValue, nonce: string, extra: Extra = {}) {
    const headers = new Headers(extra.headers);
    headers.set("Content-Type", "application/json");
    headers.set("Replay-Nonce", nonce);
    return new Response(JSON.stringify(body), {
      status: extra.status ?? 200,
      headers,
    });
  }

  private refuse(type: string, status: number, nonce: string) {
    return new Response(
      JSON.stringify({
        type: `urn:ietf:params:acme:error:${type}`,
        detail: CA_WORDS,
        status,
      }),
      {
        status,
        headers: {
          "Content-Type": "application/problem+json",
          "Replay-Nonce": nonce,
        },
      },
    );
  }

  private orderBody(order: Order) {
    const body: OrderBody = {
      status: order.state,
      identifiers: order.names.map((value) => ({ type: "dns", value })),
      authorizations: order.authzs,
      finalize: order.url.replace("/order/", "/finalize/"),
      certificate:
        order.state === "valid"
          ? `${BASE}/acme/cert/${order.url.split("/").pop()}`
          : null,
    };
    return body;
  }

  private challengeUrl(authzUrl: string): string {
    return `${BASE}/acme/chall/${authzUrl.split("/").pop()}`;
  }

  private authzBody(url: string, authz: Authz) {
    const settled = ["ready", "processing", "valid"].includes(
      authz.order.state,
    );
    const valid = this.options.alreadyValid?.includes(authz.name) || settled;
    const status =
      authz.order.state === "invalid" ? "invalid" : valid ? "valid" : "pending";
    const challenge = this.challengeUrl(url);
    return {
      identifier: { type: "dns", value: authz.name },
      status,
      wildcard: authz.wildcard,
      challenges: [
        {
          type: "http-01",
          url: `${challenge}-http`,
          token: `${authz.token}http`,
          status: "pending",
        },
        {
          type: "dns-01",
          url: challenge,
          token: authz.token,
          status: this.answered.has(challenge) ? "processing" : "pending",
        },
      ],
    };
  }

  /** Parse and verify a signed request the way RFC 8555 §6.2 asks. */
  private open(url: string, init: RequestInit | undefined): Signed {
    const envelope = JSON.parse(String(init?.body));
    const decode = (text: string) =>
      JSON.parse(Buffer.from(text, "base64url").toString());
    const header = decode(envelope.protected);
    const payload = envelope.payload ? decode(envelope.payload) : null;
    this.calls.push({
      method: "POST",
      url,
      payload,
      protectedHeader: header,
      init,
    });
    const jwk: Jwk | undefined = header.jwk
      ? header.jwk
      : [...this.accounts.values()].find(
          (entry) => `${BASE}/acme/acct/${entry.id}` === header.kid,
        )?.jwk;
    const signed =
      jwk !== undefined &&
      verify(
        "sha256",
        Buffer.from(`${envelope.protected}.${envelope.payload}`),
        {
          key: createPublicKey({ key: jwk, format: "jwk" }),
          dsaEncoding: "ieee-p1363",
        },
        Buffer.from(envelope.signature, "base64url"),
      );
    return { nonce: header.nonce, header, payload, jwk, signed };
  }

  /** The reason a signed request is refused before it reaches any endpoint, if there is one. */
  private rejection(
    url: string,
    init: RequestInit | undefined,
    request: Signed,
    next: string,
  ): Response | null {
    const { header, jwk, signed } = request;
    if (
      header.alg !== "ES256" ||
      header.url !== url ||
      !this.issued.delete(request.nonce)
    )
      return this.refuse("badNonce", 400, next);
    if (this.options.staleNonceAlways || this.stale > 0) {
      this.stale -= 1;
      return this.refuse("badNonce", 400, next);
    }
    const type = new Headers(init?.headers).get("content-type");
    if (type !== "application/jose+json")
      return this.refuse("malformed", 400, next);
    if (!jwk || (header.kid && this.options.accountGone))
      return this.refuse("accountDoesNotExist", 400, next);
    return signed ? null : this.refuse("malformed", 400, next);
  }

  private newAccount(request: Signed, next: string) {
    if (this.options.rateLimitedAccount)
      return this.refuse("rateLimited", 429, next);
    if (request.payload?.termsOfServiceAgreed !== true)
      return this.refuse("userActionRequired", 403, next);
    const { jwk } = request;
    if (!jwk) return this.refuse("malformed", 400, next);
    const key = jwkThumbprint(jwk);
    const known = this.accounts.get(key);
    const entry = known ?? { id: 40_000 + this.accounts.size + 2, jwk };
    this.accounts.set(key, entry);
    return this.respond({ status: "valid" }, next, {
      status: known ? 200 : 201,
      headers: new Headers({ Location: `${BASE}/acme/acct/${entry.id}` }),
    });
  }

  private newOrder(request: Signed, next: string) {
    const problem = this.options.orderProblem;
    if (problem) return this.refuse(problem.type, problem.status, next);
    const identifiers = request.payload?.identifiers ?? [];
    const names = identifiers.map((entry) => entry.value);
    const order: Order = {
      url: `${BASE}/acme/order/42/${this.orders.size + 7}`,
      names,
      state: "pending",
      polls: 0,
      authzs: [],
    };
    for (const name of names) {
      const authzUrl = `${BASE}/acme/authz/42/${order.url.split("/").pop()}-${order.authzs.length}`;
      this.authzs.set(authzUrl, {
        order,
        name: name.replace("*.", ""),
        wildcard: name.startsWith("*."),
        token: createHash("sha256").update(authzUrl).digest("base64url"),
      });
      order.authzs.push(authzUrl);
    }
    this.orders.set(order.url, order);
    return this.respond(this.orderBody(order), next, {
      status: 201,
      headers: new Headers({ Location: order.url }),
    });
  }

  private readOrder(order: Order, next: string) {
    if (order.state === "processing") {
      if (order.polls >= (this.options.processingPolls ?? 0))
        order.state = "valid";
      else order.polls += 1;
    }
    return this.respond(this.orderBody(order), next, {
      headers: new Headers(
        order.state === "processing" ? { "Retry-After": "1" } : {},
      ),
    });
  }

  /** The CA looks the TXT records up once every challenge it needs has been answered. */
  private answer(url: string, next: string) {
    this.answered.add(url);
    for (const held of this.orders.values()) {
      const needed = held.authzs.filter(
        (authzUrl) =>
          !this.options.alreadyValid?.includes(
            this.authzs.get(authzUrl)?.name ?? "",
          ),
      );
      const done = needed.every((authzUrl) =>
        this.answered.has(this.challengeUrl(authzUrl)),
      );
      if (held.state === "pending" && done)
        held.state = this.options.publish ? "ready" : "invalid";
    }
    return this.respond({ type: "dns-01", url, status: "processing" }, next);
  }

  private async finalize(url: string, request: Signed, next: string) {
    const held = this.orders.get(url.replace("/finalize/", "/order/"));
    if (!held || held.state !== "ready")
      return this.refuse("orderNotReady", 403, next);
    const csr = Buffer.from(String(request.payload?.csr), "base64url");
    const parsed = parseCsr(new Uint8Array(csr));
    this.csrs.push({
      names: parsed.names,
      spki: parsed.spki,
      verified: await csrSignatureHolds(parsed),
    });
    held.state = this.options.processingPolls ? "processing" : "valid";
    return this.respond(this.orderBody(held), next);
  }

  private async post(url: string, init: RequestInit | undefined) {
    const request = this.open(url, init);
    const next = this.mint();
    const rejected = this.rejection(url, init, request, next);
    if (rejected) return rejected;
    if (url === `${BASE}/acme/new-acct`) return this.newAccount(request, next);
    if (url === `${BASE}/acme/new-order`) return this.newOrder(request, next);
    const order = this.orders.get(url);
    if (order) return this.readOrder(order, next);
    const authz = this.authzs.get(url);
    if (authz) return this.respond(this.authzBody(url, authz), next);
    if (url.startsWith(`${BASE}/acme/chall/`)) return this.answer(url, next);
    if (url.startsWith(`${BASE}/acme/finalize/`))
      return this.finalize(url, request, next);
    if (url.startsWith(`${BASE}/acme/cert/`))
      return new Response(PEM_CHAIN, {
        headers: {
          "Content-Type": "application/pem-certificate-chain",
          "Replay-Nonce": next,
        },
      });
    return this.refuse("malformed", 404, next);
  }

  async handle(url: string, init: RequestInit | undefined) {
    const method = init?.method ?? "GET";
    if (method === "GET" && url === `${BASE}/directory`)
      return new Response(
        JSON.stringify({
          newNonce: `${BASE}/acme/new-nonce`,
          newAccount: `${BASE}/acme/new-acct`,
          newOrder: `${BASE}/acme/new-order`,
          ...this.options.directory,
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    if (method === "HEAD" && url === `${BASE}/acme/new-nonce`)
      return new Response(null, { headers: { "Replay-Nonce": this.mint() } });
    if (method === "POST") return this.post(url, init);
    return new Response("no", { status: 405 });
  }
}

export function fakeAcme(options: FakeAcmeOptions = {}) {
  const ca = new FakeCa(options);
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) =>
    ca.handle(String(input), init),
  );
  const assertCurrent = vi.fn();
  return {
    fetch,
    calls: ca.calls,
    csrs: ca.csrs,
    orders: ca.orders,
    authzs: ca.authzs,
    accounts: ca.accounts,
    transport: { fetch, assertCurrent },
  };
}
