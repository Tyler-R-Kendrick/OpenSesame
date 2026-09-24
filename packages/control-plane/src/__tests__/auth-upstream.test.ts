import { createHash, randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import type { UpstreamAuthDatabase } from "@opensesame/auth-upstream";
import * as schema from "@opensesame/database";
import { overlapCast } from "@opensesame/os-domain";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AppContext } from "../context.js";
import { resetEmailLinkBudget } from "../routes/interactions-email.js";
import type { startServer } from "../server.js";
import {
  emailIdentityIssuer,
  upstreamAuthFor,
} from "../services/better-auth-bridge.js";
import { onFreePort } from "./free-port.js";

/**
 * Email magic-link, end to end through the mounted Better Auth (C20 / C22 /
 * D16 / D18).
 *
 * Nothing here is simulated. A real control plane runs on a real port; the
 * request goes through the hosted login page's real form; the link is read out
 * of a message nodemailer actually composed through its `jsonTransport`; and
 * the click is a real GET that lands in the interaction it started from. The
 * only thing that does not happen is the SMTP conversation — which is the
 * entire and only difference between this transport and the production one.
 */

const RP_ORIGIN = "http://127.0.0.1:4321";
const RP_CLIENT_ID = `origin:${RP_ORIGIN}`;
const RP_REDIRECT = `${RP_ORIGIN}/opensesame/callback`;

type Started = Awaited<ReturnType<typeof startServer>>;
type LoginPage = { jar: Jar; uid: string; html: string };
/** The fields the hosted login page's email form actually posts. */
type EmailForm = { _csrf: string; email: string };
/** What the C13-shaped completion route answers with (C20). */
type BridgedSession = { principalId: string; accessToken: string };
/** The message shape nodemailer's MailComposer pass produces. */
type ComposedMail = {
  subject?: string;
  text?: string;
  to?: { address?: string }[];
  from?: { address?: string };
  messageId?: string;
};

/** Minimal cookie jar: a superset of browser path-scoping, fine for tests. */
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

  get(name: string): string | undefined {
    return this.cookies.get(name);
  }

  header() {
    if (this.cookies.size === 0) return {};
    return {
      cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "),
    };
  }
}

function extractCsrf(html: string): string {
  const match = html.match(/name="_csrf" value="([^"]+)"/);
  if (!match?.[1]) throw new Error("no csrf token in page");
  return match[1];
}

describe("email magic-link sign-in", () => {
  let started: Started;
  let base: string;
  let ctx: AppContext;

  beforeAll(async () => {
    const { startServer: start } = await import("../server.js");
    started = await onFreePort((port) =>
      start({
        config: {
          host: "127.0.0.1",
          port,
          // publicUrl must match the real bound port: it is the origin-profile
          // client id and the base of every link this suite reads out of a
          // message.
          publicUrl: `http://127.0.0.1:${port}`,
          issuer: `http://127.0.0.1:${port}`,
        },
        processEnv: {
          ...process.env,
          OPENSESAME_ORIGIN_CLIENTS_ENABLED: "true",
        },
      }),
    );
    base = `http://127.0.0.1:${started.port}`;
    ctx = started.ctx;
  }, 30_000);

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      started.server.close((err) => (err ? reject(err) : resolve())),
    );
  });

  beforeEach(() => {
    resetEmailLinkBudget();
  });

  async function req(
    jar: Jar,
    path: string,
    init: RequestInit = {},
  ): Promise<Response> {
    const url = path.startsWith("http") ? path : `${base}${path}`;
    const res = await fetch(url, {
      redirect: "manual",
      ...init,
      headers: { ...jar.header(), ...overlapCast(init.headers) },
    });
    jar.absorb(res);
    return res;
  }

  async function loginPage(): Promise<LoginPage> {
    const jar = new Jar();
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const params = new URLSearchParams({
      client_id: RP_CLIENT_ID,
      redirect_uri: RP_REDIRECT,
      response_type: "code",
      scope: "openid",
      state: "s-1",
      nonce: "n-1",
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    const res = await req(jar, `/auth?${params.toString()}`);
    expect(res.status).toBe(303);
    const location = res.headers.get("location") ?? "";
    const uid = location.slice("/interaction/".length);
    const page = await req(jar, location);
    return { jar, uid, html: await page.text() };
  }

  /** The last message nodemailer composed, parsed back out of the outbox. */
  function lastMail(): ComposedMail {
    const captured = ctx.mailer.outbox.at(-1);
    if (!captured) throw new Error("no message was composed");
    // SAFETY: `body` is `info.message` from nodemailer's jsonTransport, which
    // is that transport's documented JSON serialization of the composed
    // message; the fields read below are all optional in `ComposedMail`.
    const composed: ComposedMail = overlapCast(JSON.parse(captured.body));
    return composed;
  }

  function linkFrom(mail: ComposedMail): string {
    const link = mail.text?.match(/https?:\/\/\S+/)?.[0];
    if (!link) throw new Error("no link in the message body");
    return link;
  }

  function postForm(fields: EmailForm): RequestInit {
    return {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields),
    };
  }

  async function requestLink(email: string): Promise<LoginPage> {
    const { jar, uid, html } = await loginPage();
    expect(html).toContain("Continue with email");
    const res = await req(
      jar,
      `/interaction/${uid}/federated/email`,
      postForm({ _csrf: extractCsrf(html), email }),
    );
    expect(res.status).toBe(200);
    return { jar, uid, html: await res.text() };
  }

  it("composes a real message carrying a single-use link into the interaction", async () => {
    const email = "traveller@example.test";
    const before = ctx.mailer.outbox.length;
    const { uid, html } = await requestLink(email);

    expect(html).toContain("Check your email");
    expect(ctx.mailer.outbox.length).toBe(before + 1);

    const mail = lastMail();
    expect(mail.to?.[0]?.address).toBe(email);
    expect(mail.subject).toBe("Your OpenSesame sign-in link");
    // A composed message, not a template string: MailComposer stamped it.
    expect(mail.messageId).toMatch(/^<.+>$/);
    expect(mail.from?.address).toBeTruthy();

    const link = new URL(linkFrom(mail));
    expect(link.origin).toBe(base);
    expect(link.pathname).toBe(`/interaction/${uid}/federated/email/verify`);
    expect(link.searchParams.get("token")).toBeTruthy();
  });

  it("signs in, mints the canonical principal, and resumes the interaction", async () => {
    const email = "newcomer@example.test";
    const { jar } = await requestLink(email);
    const link = linkFrom(lastMail());

    const verified = await req(jar, link);
    expect(verified.status).toBe(303);
    // A session for the browser that proved control of the address.
    expect(jar.get(ctx.config.provisionalCookieName)).toMatch(/^pst_/);

    const identity = await ctx.repos.externalIdentities.findByTuple({
      kind: "email",
      issuer: emailIdentityIssuer(ctx),
      subject: email,
    });
    expect(identity).not.toBeNull();
    const principal = await ctx.repos.principals.getById(
      identity?.principalId ?? "",
    );
    expect(principal?.state).toBe("active");
    expect(principal?.assurance).toBe("verified");

    // The interaction really finished: following the resume URL leaves the
    // login prompt behind for the consent prompt (200) or goes straight back
    // to the relying party (303), and the account is bound either way.
    const resumed = await req(jar, verified.headers.get("location") ?? "");
    expect([200, 303]).toContain(resumed.status);
    expect(resumed.headers.get("location") ?? "").not.toContain(
      "/federated/email",
    );
  });

  it("spends the token on first use, not merely the interaction", async () => {
    const { jar } = await requestLink("once@example.test");
    const link = new URL(linkFrom(lastMail()));
    const token = link.searchParams.get("token") ?? "";

    expect((await req(jar, link.toString())).status).toBe(303);

    // Re-offer the SAME token to the route that needs no interaction to
    // resume. A second session here would mean the link was replayable and the
    // first refusal was only the finished interaction talking.
    const replay = await fetch(
      `${base}/v1/auth/magic-link/complete?token=${encodeURIComponent(token)}`,
      { redirect: "manual" },
    );
    expect(replay.status).toBe(401);
    expect(await replay.json()).toEqual({ error: "invalid_token" });
  });

  it("refuses a link whose token was never issued", async () => {
    const { jar, uid } = await requestLink("stranger@example.test");
    const res = await req(
      jar,
      `/interaction/${uid}/federated/email/verify?token=${"a".repeat(32)}`,
    );
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain("expired or was already used");
    // A fresh CSRF token, so the re-rendered page is usable (T13).
    expect(extractCsrf(html)).toBeTruthy();
    // Hosted pages run under `default-src 'none'` with no script-src (T5).
    expect(html).not.toContain("<script");
  });

  it("attaches to the principal that already owns the verified email (D15)", async () => {
    const email = "returning@example.test";
    const { jar } = await requestLink(email);
    const first = await req(jar, linkFrom(lastMail()));
    expect(first.status).toBe(303);
    const identity = await ctx.repos.externalIdentities.findByTuple({
      kind: "email",
      issuer: emailIdentityIssuer(ctx),
      subject: email,
    });
    const principalId = identity?.principalId ?? "";
    expect(principalId).toMatch(/^prn_/);

    const { jar: second } = await requestLink(email);
    const again = await req(second, linkFrom(lastMail()));
    expect(again.status).toBe(303);

    // One human, one principal — no duplicate account on the second sign-in.
    const bearer = second.get(ctx.config.provisionalCookieName) ?? "";
    const sessionId = ctx.stores.provisionalTokens.get(bearer);
    expect(
      sessionId && ctx.stores.provisionalSessions.get(sessionId)?.principalId,
    ).toBe(principalId);
  });

  it("re-renders with an error and sends nothing for an unusable address", async () => {
    const { jar, uid, html } = await loginPage();
    const before = ctx.mailer.outbox.length;
    const res = await req(
      jar,
      `/interaction/${uid}/federated/email`,
      postForm({ _csrf: extractCsrf(html), email: "not-an-address" }),
    );
    expect(res.status).toBe(200);
    const rendered = await res.text();
    expect(rendered).toContain("Enter an email address");
    expect(ctx.mailer.outbox.length).toBe(before);
    expect(extractCsrf(rendered)).toBeTruthy();
  });

  it("refuses a request without the interaction's CSRF token", async () => {
    const { jar, uid } = await loginPage();
    const before = ctx.mailer.outbox.length;
    const res = await req(
      jar,
      `/interaction/${uid}/federated/email`,
      postForm({ _csrf: "forged", email: "csrf@example.test" }),
    );
    expect(res.status).toBe(403);
    expect(ctx.mailer.outbox.length).toBe(before);
  });

  it("caps how many links one address can be sent, without saying so", async () => {
    const email = "flooded@example.test";
    const before = ctx.mailer.outbox.length;
    for (let attempt = 0; attempt < 7; attempt += 1) {
      const { html } = await requestLink(email);
      // Every attempt gets the same page: a budget that announced itself would
      // be an oracle for which addresses are worth flooding.
      expect(html).toContain("Check your email");
    }
    expect(ctx.mailer.outbox.length - before).toBe(5);
  });
});

describe("the Better Auth mount serves magic-link and nothing else", () => {
  let started: Started;
  let base: string;
  let ctx: AppContext;

  beforeAll(async () => {
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
        },
      }),
    );
    base = `http://127.0.0.1:${started.port}`;
    ctx = started.ctx;
  }, 30_000);

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      started.server.close((err) => (err ? reject(err) : resolve())),
    );
  });

  beforeEach(() => {
    resetEmailLinkBudget();
  });

  it.each([
    ["POST", "/v1/auth/sign-in/social"],
    ["POST", "/v1/auth/sign-in/email"],
    ["POST", "/v1/auth/sign-up/email"],
    ["GET", "/v1/auth/callback/github"],
    ["POST", "/v1/auth/link-social"],
  ])("does not serve %s %s (T22)", async (method, path) => {
    const init: RequestInit = {
      method,
      redirect: "manual",
      headers: { "content-type": "application/json" },
    };
    if (method === "POST") init.body = JSON.stringify({ provider: "github" });
    const res = await fetch(`${base}${path}`, init);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  it.each(["/v1/auth/magic-link/verify?token=x", "/v1/auth/get-session"])(
    "does not expose the Better Auth session surface at %s (T33)",
    async (path) => {
      const res = await fetch(`${base}${path}`, { redirect: "manual" });
      expect(res.status).toBe(404);
    },
  );

  it("issues a first-party bearer for a link a client requested itself", async () => {
    const email = "pages-visitor@example.test";
    const requested = await fetch(`${base}/v1/auth/sign-in/magic-link`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email }),
    });
    expect(requested.status).toBe(200);
    expect(await requested.json()).toMatchObject({ status: true });

    // SAFETY: jsonTransport's serialization of the composed message, whose
    // fields are all optional in `ComposedMail`.
    const mail: ComposedMail = overlapCast(
      JSON.parse(ctx.mailer.outbox.at(-1)?.body ?? "{}"),
    );
    const link = new URL(mail.text?.match(/https?:\/\/\S+/)?.[0] ?? "");
    // No interaction started this one, so it lands on the API route (D18).
    expect(link.pathname).toBe("/v1/auth/magic-link/complete");

    const completed = await fetch(link, { redirect: "manual" });
    expect(completed.status).toBe(200);
    // SAFETY: the route answers this shape on 200, asserted a line above.
    const session: BridgedSession = overlapCast(await completed.json());
    expect(session.principalId).toMatch(/^prn_/);
    expect(session.accessToken).toMatch(/^pst_/);

    // Single-use: the same link cannot mint a second session.
    expect((await fetch(link, { redirect: "manual" })).status).toBe(401);
  });

  it("never puts a Better Auth user id in a /v1 response body (T33)", async () => {
    const email = "no-leak@example.test";
    const bodies: string[] = [];

    const requested = await fetch(`${base}/v1/auth/sign-in/magic-link`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email }),
    });
    bodies.push(await requested.text());

    // SAFETY: jsonTransport's serialization of the composed message, whose
    // fields are all optional in `ComposedMail`.
    const mail: ComposedMail = overlapCast(
      JSON.parse(ctx.mailer.outbox.at(-1)?.body ?? "{}"),
    );
    const link = mail.text?.match(/https?:\/\/\S+/)?.[0] ?? "";
    const completed = await fetch(link, { redirect: "manual" });
    const sessionBody = await completed.text();
    bodies.push(sessionBody);
    // SAFETY: the completion route answers the bridged-session shape on 200.
    const session: BridgedSession = overlapCast(JSON.parse(sessionBody));

    // Read the id straight out of Better Auth's own store: the assertion is
    // about the real value, not about a shape a regex guessed at.
    const authContext = await upstreamAuthFor(ctx).auth.$context;
    const found = await authContext.internalAdapter.findUserByEmail(email);
    const betterAuthUserId = found?.user.id ?? "";
    expect(betterAuthUserId).toBeTruthy();
    expect(betterAuthUserId).not.toBe(session.principalId);

    // Sweep the /v1 surface this session can reach while holding its bearer.
    const authorized = { authorization: `Bearer ${session.accessToken}` };
    for (const path of [
      "/v1/federated/providers",
      "/v1/audit?limit=100",
      "/v1/projects",
      "/v1/organizations",
      "/v1/health/live",
    ]) {
      const res = await fetch(`${base}${path}`, { headers: authorized });
      bodies.push(await res.text());
    }

    for (const body of bodies) {
      expect(body).not.toContain(betterAuthUserId);
    }
  });
});

/**
 * A magic link is a row, not a memory (ADR 0057).
 *
 * `betterAuth()` was originally constructed with no `database`, so it fell
 * through to Better Auth's in-memory adapter. Every test passed, because a
 * test requests and follows a link inside one process. Real deployments do
 * not: the link is emailed, the human reads it minutes later, and by then the
 * request may reach a different replica — or the same one after a deploy.
 * Under the old wiring every outstanding link died at both of those moments,
 * with no error anywhere, just a token nothing had heard of.
 *
 * Two control planes over one Postgres is that situation, run forwards. The
 * database is a real in-process Postgres with the real migrations applied, so
 * the tables under test are the ones the deployment gets.
 */
describe("magic links outlive the instance that minted them", () => {
  let client: PGlite;
  let betterAuthDatabase: UpstreamAuthDatabase;

  beforeAll(async () => {
    client = new PGlite();
    await client.waitReady;
    const db = drizzle(client, { schema });
    await migrate(db, {
      migrationsFolder: join(
        dirname(fileURLToPath(import.meta.url)),
        "../../../../packages/database/drizzle",
      ),
    });
    betterAuthDatabase = {
      drizzle: db,
      schema: {
        user: schema.betterAuthUsers,
        session: schema.betterAuthSessions,
        account: schema.betterAuthAccounts,
        verification: schema.betterAuthVerifications,
      },
    };
  }, 60_000);

  afterAll(async () => {
    await client.close();
  });

  beforeEach(() => {
    resetEmailLinkBudget();
  });

  /** A control plane sharing the one database — a replica, or a redeploy. */
  async function instance(): Promise<Started> {
    const { startServer: start } = await import("../server.js");
    return onFreePort((port) =>
      start({
        config: {
          host: "127.0.0.1",
          port,
          publicUrl: `http://127.0.0.1:${port}`,
          issuer: `http://127.0.0.1:${port}`,
        },
        betterAuthDatabase,
        processEnv: {
          ...process.env,
          OPENSESAME_ORIGIN_CLIENTS_ENABLED: "true",
        },
      }),
    );
  }

  async function close(started: Started): Promise<void> {
    await new Promise<void>((resolve, reject) =>
      started.server.close((err) => (err ? reject(err) : resolve())),
    );
  }

  it("verifies on a second instance a link a first one sent", async () => {
    const minted = await instance();
    const email = "durable@example.test";
    const requested = await fetch(
      `http://127.0.0.1:${minted.port}/v1/auth/sign-in/magic-link`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email }),
      },
    );
    expect(requested.status).toBe(200);

    // SAFETY: jsonTransport's serialization of the composed message, whose
    // fields are all optional in `ComposedMail`.
    const mail: ComposedMail = overlapCast(
      JSON.parse(minted.ctx.mailer.outbox.at(-1)?.body ?? "{}"),
    );
    const link = new URL(mail.text?.match(/https?:\/\/\S+/)?.[0] ?? "");
    const token = link.searchParams.get("token") ?? "";
    expect(token).not.toBe("");

    // The instance that sent the email is gone before the link is followed.
    await close(minted);

    const other = await instance();
    try {
      const completed = await fetch(
        `http://127.0.0.1:${other.port}/v1/auth/magic-link/complete?token=${encodeURIComponent(token)}`,
        { redirect: "manual" },
      );
      expect(completed.status).toBe(200);
      // SAFETY: the route answers this shape on 200, asserted a line above.
      const session: BridgedSession = overlapCast(await completed.json());
      expect(session.principalId).toMatch(/^prn_/);
      expect(session.accessToken).toMatch(/^pst_/);

      // Still single-use across instances: the row was consumed, not copied.
      const replayed = await fetch(
        `http://127.0.0.1:${other.port}/v1/auth/magic-link/complete?token=${encodeURIComponent(token)}`,
        { redirect: "manual" },
      );
      expect(replayed.status).toBe(401);
    } finally {
      await close(other);
    }
  }, 60_000);

  it("stores the link hashed, so the table is not a set of sign-in links", async () => {
    const started = await instance();
    try {
      const email = "hashed@example.test";
      await fetch(
        `http://127.0.0.1:${started.port}/v1/auth/sign-in/magic-link`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email }),
        },
      );
      // SAFETY: jsonTransport's serialization of the composed message.
      const mail: ComposedMail = overlapCast(
        JSON.parse(started.ctx.mailer.outbox.at(-1)?.body ?? "{}"),
      );
      const token =
        new URL(mail.text?.match(/https?:\/\/\S+/)?.[0] ?? "").searchParams.get(
          "token",
        ) ?? "";
      expect(token).not.toBe("");

      const rows = await client.query<{ value: string; identifier: string }>(
        "select value, identifier from better_auth_verifications",
      );
      expect(rows.rows.length).toBeGreaterThan(0);
      // `storeToken: "hashed"` — a database read hands an attacker nothing
      // they can paste into a browser.
      for (const row of rows.rows) expect(row.value).not.toBe(token);
    } finally {
      await close(started);
    }
  }, 60_000);
});
