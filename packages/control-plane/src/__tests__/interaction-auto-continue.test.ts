/**
 * Auto-continue (OPENSESAME_INTERACTION_AUTO_CONTINUE, ON by default): a login
 * interaction whose provider hint matches 303s straight into the provider's
 * leg — once. The per-interaction cookie is the loop guard T14 demands: any
 * second visit, and every refusal return, renders the full page.
 */

import { createHash, randomBytes } from "node:crypto";
import {
  type ReferenceIdp,
  startReferenceIdp,
} from "@opensesame/mock-upstream-idp/testkit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { startServer } from "../server.js";
import { onFreePort } from "./free-port.js";

type Started = Awaited<ReturnType<typeof startServer>>;

type StartedInteraction = { uid: string; location: string };

const RP_ORIGIN = "http://127.0.0.1:4319";
const RP_CLIENT_ID = `origin:${RP_ORIGIN}`;
const RP_REDIRECT = `${RP_ORIGIN}/opensesame/callback`;

class Jar {
  private cookies = new Map<string, string>();

  absorb(res: Response): void {
    for (const sc of res.headers.getSetCookie()) {
      const pair = sc.split(";")[0] ?? "";
      const idx = pair.indexOf("=");
      if (idx <= 0) continue;
      const name = pair.slice(0, idx).trim();
      const value = pair.slice(idx + 1).trim();
      if (value) this.cookies.set(name, value);
      else this.cookies.delete(name);
    }
  }

  has(prefix: string): boolean {
    return [...this.cookies.keys()].some((name) => name.startsWith(prefix));
  }

  header(): HeadersInit {
    if (this.cookies.size === 0) return {};
    return {
      cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "),
    };
  }
}

async function req(base: string, jar: Jar, path: string): Promise<Response> {
  const url = path.startsWith("http") ? path : `${base}${path}`;
  const res = await fetch(url, { redirect: "manual", headers: jar.header() });
  jar.absorb(res);
  return res;
}

/**
 * The default, pinned.
 *
 * Every case below sets the flag explicitly, which is exactly what let the
 * behaviour ship switched off: a broker that renders its own picker for a
 * sign-in the relying party already directed is not a broker, and no test
 * noticed because none of them ran without the env var. This suite boots a
 * control plane with the variable ABSENT and asserts the hop happens anyway.
 */
describe("interaction auto-continue is the default", () => {
  let upstream: ReferenceIdp;
  let started: Started;
  let base: string;

  beforeAll(async () => {
    upstream = await startReferenceIdp();
    const { startServer: start } = await import("../server.js");
    // Deliberately no OPENSESAME_INTERACTION_AUTO_CONTINUE — and scrubbed
    // from the inherited environment, so a developer who exports it cannot
    // make this pass for the wrong reason.
    const { OPENSESAME_INTERACTION_AUTO_CONTINUE: _unset, ...cleanEnv } =
      process.env;
    started = await onFreePort((port) =>
      start({
        config: {
          host: "127.0.0.1",
          port,
          publicUrl: `http://127.0.0.1:${port}`,
          issuer: `http://127.0.0.1:${port}`,
        },
        processEnv: {
          ...cleanEnv,
          OPENSESAME_ORIGIN_CLIENTS_ENABLED: "true",
          OPENSESAME_TRUSTED_UPSTREAMS: upstream.issuer,
        },
      }),
    );
    // The bound port, not the one we asked for: a retried bind lands elsewhere.
    base = `http://127.0.0.1:${started.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      started.server.close((err) => (err ? reject(err) : resolve())),
    );
    await upstream.close();
  });

  it("hops a hinted sign-in with no env var set", async () => {
    const jar = new Jar();
    const verifier = randomBytes(32).toString("base64url");
    const params = new URLSearchParams({
      client_id: RP_CLIENT_ID,
      redirect_uri: RP_REDIRECT,
      response_type: "code",
      scope: "openid",
      state: "s-default",
      nonce: "n-default",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      kc_idp_hint: "mock",
    });
    const auth = await req(base, jar, `/auth?${params.toString()}`);
    expect(auth.status).toBe(303);
    const location = auth.headers.get("location") ?? "";

    const interaction = await req(base, jar, location);
    // Straight to the provider, no page in between: the whole point.
    expect(interaction.status).toBe(303);
    expect(interaction.headers.get("location") ?? "").toContain(
      upstream.issuer,
    );
  }, 30_000);

  it("still renders the page when the relying party named nothing", async () => {
    // The default removes a click the relying party already made; it never
    // removes a choice nobody made.
    const jar = new Jar();
    const verifier = randomBytes(32).toString("base64url");
    const params = new URLSearchParams({
      client_id: RP_CLIENT_ID,
      redirect_uri: RP_REDIRECT,
      response_type: "code",
      scope: "openid",
      state: "s-nohint",
      nonce: "n-nohint",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
    });
    const auth = await req(base, jar, `/auth?${params.toString()}`);
    const interaction = await req(
      base,
      jar,
      auth.headers.get("location") ?? "",
    );
    expect(interaction.status).toBe(200);
  }, 30_000);
});

describe("interaction auto-continue", () => {
  let upstream: ReferenceIdp;
  let started: Started;
  let base: string;

  beforeAll(async () => {
    upstream = await startReferenceIdp();
    const { startServer: start } = await import("../server.js");
    started = await onFreePort((port) =>
      start({
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
          OPENSESAME_INTERACTION_AUTO_CONTINUE: "true",
        },
      }),
    );
    // The bound port, not the one we asked for: a retried bind lands elsewhere.
    base = `http://127.0.0.1:${started.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      started.server.close((err) => (err ? reject(err) : resolve())),
    );
    await upstream.close();
  });

  async function beginInteraction(
    jar: Jar,
    hint?: string,
  ): Promise<StartedInteraction> {
    const verifier = randomBytes(32).toString("base64url");
    const params = new URLSearchParams({
      client_id: RP_CLIENT_ID,
      redirect_uri: RP_REDIRECT,
      response_type: "code",
      scope: "openid",
      state: "s-1",
      nonce: "n-1",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
    });
    if (hint !== undefined) params.set("kc_idp_hint", hint);
    const res = await req(base, jar, `/auth?${params.toString()}`);
    expect(res.status).toBe(303);
    const location = res.headers.get("location") ?? "";
    return { uid: location.slice("/interaction/".length), location };
  }

  it("hops straight into the hinted provider once, then renders the page", async () => {
    const jar = new Jar();
    // The hint names the issuer — one of the spellings the hint matcher takes.
    const { uid, location } = await beginInteraction(jar, upstream.issuer);

    const first = await req(base, jar, location);
    expect(first.status).toBe(303);
    const authorizeUrl = first.headers.get("location") ?? "";
    expect(authorizeUrl.startsWith(upstream.issuer)).toBe(true);
    expect(authorizeUrl).toContain("code_challenge_method=S256");
    // Both the loop guard and the pending leg state were set on the way out.
    expect(jar.has(`os.auto.${uid}`)).toBe(true);
    expect(jar.has(`os.fed.${uid}`)).toBe(true);

    // The one silent hop is spent: a second visit renders the full page.
    const second = await req(base, jar, location);
    expect(second.status).toBe(200);
    expect(await second.text()).toContain("Sign in");
  });

  it("renders the page with the banner, not another hop, after a refusal", async () => {
    const jar = new Jar();
    const { uid, location } = await beginInteraction(jar, upstream.issuer);

    const hop = await req(base, jar, location);
    expect(hop.status).toBe(303);

    const back = await req(
      base,
      jar,
      `/interaction/${uid}/federated/callback?error=access_denied`,
    );
    expect(back.status).toBe(303);
    expect(back.headers.get("location")).toBe(
      `/interaction/${uid}?fed_error=access_denied`,
    );

    const page = await req(base, jar, back.headers.get("location") ?? "");
    expect(page.status).toBe(200);
    const body = await page.text();
    expect(body).toContain('role="alert"');
    expect(body).toContain("access was denied");
  });

  it("never hops without a hint", async () => {
    const jar = new Jar();
    const { location } = await beginInteraction(jar);

    const res = await req(base, jar, location);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Sign in");
  });
});
