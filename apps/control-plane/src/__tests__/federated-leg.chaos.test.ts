import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { overlapCast } from "@opensesame/os-domain";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resetFederatedDiscoveryCache } from "../interactions/federated.js";
import type { startServer } from "../server.js";

type Started = Awaited<ReturnType<typeof startServer>>;
type ChaosClaims = {
  nonce: string;
  pairwise_sub?: string;
};

/**
 * Chaos for the federated relying-party leg (ADR 0052).
 *
 * A broker is a third party on the far side of a network. It can be down,
 * slow, wrong, or actively hostile, and none of those may be allowed to admit
 * a principal. Each case here injects one fault into an otherwise-working
 * upstream and asserts the same invariant: the interaction does **not**
 * complete, and no session cookie is issued.
 *
 * The failure mode being guarded against is a leg that treats "I could not
 * verify this" as "this is fine" — an admission on a token nobody vouched for.
 */

type Fault =
  | "none"
  | "discovery_500"
  | "discovery_garbage"
  | "token_500"
  | "token_garbage"
  | "wrong_issuer"
  | "wrong_audience"
  | "wrong_nonce"
  | "expired"
  | "unsigned_alg"
  | "foreign_key"
  | "no_subject"
  | "no_id_token"
  | "revocation_500";

let fault: Fault = "none";
/** How many times the broker's revocation endpoint was called (D13). */
let revocationsSeen = 0;

async function startChaosUpstream() {
  const { privateKey, publicKey } = await generateKeyPair("RS256", {
    extractable: true,
  });
  // A second, unadvertised key: signing with it proves JWKS is actually used.
  const foreign = await generateKeyPair("RS256", { extractable: true });
  const jwk = { ...(await exportJWK(publicKey)), kid: "chaos-1", alg: "RS256" };
  const codes = new Map<
    string,
    { challenge: string; nonce: string; cid: string }
  >();

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
    const issuer = `http://127.0.0.1:${port}`;
    const json = <Body>(code: number, body: Body) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };

    if (url.pathname === "/.well-known/openid-configuration") {
      if (fault === "discovery_500") return void res.writeHead(500).end("nope");
      if (fault === "discovery_garbage") {
        res.writeHead(200, { "content-type": "application/json" });
        return void res.end("{not json");
      }
      return void json(200, {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        // Advertised so the D13 disposal path is genuinely exercised: the
        // token response below always carries a refresh token nobody asked
        // for, and the leg has to try to hand it back.
        revocation_endpoint: `${issuer}/revoke`,
        jwks_uri: `${issuer}/jwks`,
        response_types_supported: ["code"],
        subject_types_supported: ["pairwise"],
        id_token_signing_alg_values_supported: ["RS256"],
        code_challenge_methods_supported: ["S256"],
      });
    }

    if (url.pathname === "/jwks") return void json(200, { keys: [jwk] });

    if (url.pathname === "/revoke" && req.method === "POST") {
      revocationsSeen += 1;
      if (fault === "revocation_500") return void res.writeHead(500).end("no");
      // RFC 7009: 200 whether or not the token was known.
      return void res.writeHead(200).end();
    }

    if (url.pathname === "/authorize") {
      const code = randomBytes(16).toString("hex");
      codes.set(code, {
        challenge: url.searchParams.get("code_challenge") ?? "",
        nonce: url.searchParams.get("nonce") ?? "",
        cid: url.searchParams.get("client_id") ?? "",
      });
      const back = new URL(url.searchParams.get("redirect_uri") ?? "");
      back.searchParams.set("code", code);
      back.searchParams.set("state", url.searchParams.get("state") ?? "");
      return void res.writeHead(303, { location: back.href }).end();
    }

    if (url.pathname === "/token" && req.method === "POST") {
      if (fault === "token_500") return void res.writeHead(500).end("nope");
      let body = "";
      req.on("data", (c) => {
        body += String(c);
      });
      req.on("end", () => {
        void (async () => {
          if (fault === "token_garbage") {
            res.writeHead(200, { "content-type": "application/json" });
            return void res.end("{not json");
          }
          const form = new URLSearchParams(body);
          const rec = codes.get(form.get("code") ?? "");
          if (!rec) return void json(400, { error: "invalid_grant" });
          const verifier = form.get("code_verifier") ?? "";
          if (
            createHash("sha256").update(verifier).digest("base64url") !==
            rec.challenge
          ) {
            return void json(400, { error: "invalid_grant" });
          }

          const claims: ChaosClaims = {
            nonce: fault === "wrong_nonce" ? "not-the-nonce" : rec.nonce,
          };
          if (fault !== "no_subject") claims.pairwise_sub = "chaos-subject";

          let jwt = new SignJWT(claims)
            .setProtectedHeader({ alg: "RS256", kid: "chaos-1" })
            .setIssuer(
              fault === "wrong_issuer" ? "https://elsewhere.test" : issuer,
            )
            .setAudience(
              fault === "wrong_audience" ? "origin:https://evil.test" : rec.cid,
            )
            .setIssuedAt();
          jwt =
            fault === "expired"
              ? jwt.setExpirationTime("-5m")
              : jwt.setExpirationTime("5m");
          if (fault !== "no_subject") jwt = jwt.setSubject("global-chaos");

          const key = fault === "foreign_key" ? foreign.privateKey : privateKey;
          const idToken =
            fault === "unsigned_alg"
              ? `${Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url")}.${Buffer.from(JSON.stringify({ ...claims, iss: issuer, aud: rec.cid })).toString("base64url")}.`
              : await jwt.sign(key);

          json(200, {
            access_token: "at",
            token_type: "Bearer",
            expires_in: 300,
            // Nobody asked for this. Brokers issue them anyway, and the leg
            // must dispose of it rather than take custody (D13).
            refresh_token: "rt-nobody-asked-for",
            // A broker that answers the grant but omits the assertion entirely.
            ...(fault === "no_id_token" ? undefined : { id_token: idToken }),
          });
        })();
      });
      return;
    }
    res.writeHead(404).end();
  });

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  // SAFETY: server.listen established the runtime AddressInfo invariant.
  const port = (server.address() as AddressInfo).port;
  return {
    issuer: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((res, rej) =>
        server.close((e) => (e ? rej(e) : res())),
      ),
  };
}

class Jar {
  private cookies = new Map<string, string>();
  absorb(res: Response): void {
    for (const sc of res.headers.getSetCookie()) {
      const pair = sc.split(";")[0] ?? "";
      const i = pair.indexOf("=");
      if (i <= 0) continue;
      const v = pair.slice(i + 1).trim();
      if (v) this.cookies.set(pair.slice(0, i).trim(), v);
      else this.cookies.delete(pair.slice(0, i).trim());
    }
  }
  get(n: string) {
    return this.cookies.get(n);
  }
  header() {
    return this.cookies.size
      ? { cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ") }
      : {};
  }
}

describe("CHAOS — a broker that misbehaves must not admit anyone", () => {
  let upstream: Awaited<ReturnType<typeof startChaosUpstream>>;
  let started: Started;
  let base: string;

  beforeAll(async () => {
    resetFederatedDiscoveryCache();
    upstream = await startChaosUpstream();
    const probe = createServer();
    await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
    // SAFETY: probe.listen established the runtime AddressInfo invariant.
    const port = (probe.address() as AddressInfo).port;
    await new Promise<void>((r) => probe.close(() => r()));
    const { startServer: start } = await import("../server.js");
    started = await start({
      config: {
        host: "127.0.0.1",
        port,
        publicUrl: `http://127.0.0.1:${port}`,
        issuer: `http://127.0.0.1:${port}`,
      },
      processEnv: {
        ...process.env,
        OPENSESAME_ORIGIN_CLIENTS_ENABLED: "true",
        OPENSESAME_TRUSTED_UPSTREAMS: upstream.issuer,
      },
    });
    base = `http://127.0.0.1:${started.port}`;
  }, 30_000);

  afterAll(async () => {
    await new Promise<void>((res, rej) =>
      started.server.close((e) => (e ? rej(e) : res())),
    );
    await upstream.close();
    resetFederatedDiscoveryCache();
  });

  beforeEach(() => {
    fault = "none";
  });

  async function req(jar: Jar, path: string, init: RequestInit = {}) {
    const res = await fetch(path.startsWith("http") ? path : `${base}${path}`, {
      redirect: "manual",
      ...init,
      headers: { ...jar.header(), ...overlapCast(init.headers) },
    });
    jar.absorb(res);
    return res;
  }

  async function toLoginPage() {
    const jar = new Jar();
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const res = await req(
      jar,
      `/auth?${new URLSearchParams({
        client_id: "origin:http://127.0.0.1:4399",
        redirect_uri: "http://127.0.0.1:4399/opensesame/callback",
        response_type: "code",
        scope: "openid",
        state: "s",
        nonce: "n",
        code_challenge: challenge,
        code_challenge_method: "S256",
      })}`,
    );
    const location = res.headers.get("location") ?? "";
    expect(res.status).toBe(303);
    const uid = location.slice("/interaction/".length);
    const html = await (await req(jar, location)).text();
    const csrf = html.match(/name="_csrf" value="([^"]+)"/)?.[1] ?? "";
    return { jar, uid, csrf };
  }

  async function startLeg(jar: Jar, uid: string, csrf: string) {
    return req(jar, `/interaction/${uid}/federated/start`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ _csrf: csrf, issuer: upstream.issuer }),
    });
  }

  it.each<[string, Fault]>([
    ["the discovery document 500s", "discovery_500"],
    ["the discovery document is not JSON", "discovery_garbage"],
  ])(
    "refuses to start when %s",
    async (_label, injected) => {
      const { jar, uid, csrf } = await toLoginPage();
      fault = injected;
      resetFederatedDiscoveryCache();

      const res = await startLeg(jar, uid, csrf);

      expect(res.status).toBe(502);
      expect(jar.get(`os.fed.${uid}`)).toBeFalsy();
      expect(jar.get("os_provisional")).toBeFalsy();
    },
    20_000,
  );

  it.each<[string, Fault]>([
    ["the token endpoint 500s", "token_500"],
    ["the token response is not JSON", "token_garbage"],
    ["the id_token names a different issuer", "wrong_issuer"],
    ["the id_token is for a different audience", "wrong_audience"],
    ["the id_token echoes the wrong nonce", "wrong_nonce"],
    ["the id_token is already expired", "expired"],
    ["the id_token is signed by an unpublished key", "foreign_key"],
    ["the id_token claims alg:none", "unsigned_alg"],
    ["the id_token carries no subject", "no_subject"],
    ["the response carries no id_token at all", "no_id_token"],
  ])(
    "admits nobody when %s",
    async (_label, injected) => {
      const { jar, uid, csrf } = await toLoginPage();
      const start = await startLeg(jar, uid, csrf);
      expect(start.status).toBe(303);

      fault = injected;
      const authorize = new URL(start.headers.get("location") ?? "");
      const upstreamRes = await fetch(authorize, { redirect: "manual" });
      const back = new URL(upstreamRes.headers.get("location") ?? "");

      const res = await req(
        jar,
        `/interaction/${uid}/federated/callback${back.search}`,
      );

      // 400 is the leg refusing; what must never happen is a 303 onward into
      // /auth (interaction complete) or a session cookie being handed out.
      expect(res.status).toBe(400);
      expect(res.headers.get("location") ?? "").not.toContain("/auth/");
      expect(jar.get("os_provisional")).toBeFalsy();
    },
    20_000,
  );

  /**
   * The mirror image of every case above: this one must NOT fail closed.
   *
   * D13 hands an unasked-for refresh token back to the issuer that minted it,
   * best effort. A revocation endpoint that 500s has not endangered anybody —
   * the token was never stored — and turning that into a failed sign-in would
   * let a broken endpoint at the upstream lock every user out.
   */
  it("completes the sign-in even when revoking the refresh token fails", async () => {
    const { jar, uid, csrf } = await toLoginPage();
    const start = await startLeg(jar, uid, csrf);
    expect(start.status).toBe(303);

    fault = "revocation_500";
    const before = revocationsSeen;
    const authorize = new URL(start.headers.get("location") ?? "");
    const upstreamRes = await fetch(authorize, { redirect: "manual" });
    const back = new URL(upstreamRes.headers.get("location") ?? "");
    const res = await req(
      jar,
      `/interaction/${uid}/federated/callback${back.search}`,
    );

    expect(res.status).toBe(303);
    expect(res.headers.get("location") ?? "").toContain("/auth/");
    // Fire-and-forget: the attempt is made, and the answer is not waited on.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(revocationsSeen).toBeGreaterThan(before);

    // And the token is nowhere in the record it left behind.
    const identity = await started.ctx.repos.externalIdentities.findByTuple({
      kind: "oidc",
      issuer: upstream.issuer,
      subject: "chaos-subject",
    });
    expect(JSON.stringify(identity ?? {})).not.toContain("rt-nobody-asked-for");
  }, 20_000);

  it("does not let a replayed callback re-run a consumed code", async () => {
    const { jar, uid, csrf } = await toLoginPage();
    const start = await startLeg(jar, uid, csrf);
    const authorize = new URL(start.headers.get("location") ?? "");
    const upstreamRes = await fetch(authorize, { redirect: "manual" });
    const back = new URL(upstreamRes.headers.get("location") ?? "");

    const first = await req(
      jar,
      `/interaction/${uid}/federated/callback${back.search}`,
    );
    expect(first.status).toBe(303);

    // The pending cookie is single-use and was dropped on the first pass.
    const replay = await req(
      jar,
      `/interaction/${uid}/federated/callback${back.search}`,
    );
    expect(replay.status).not.toBe(303);
  }, 20_000);
});
