/**
 * A NATS carrier's own fields and the credentials a session mints from an
 * account signing key (ADR 0166): read strictly, scoped to one session,
 * expiring with it, and the signing key never in a link.
 */
import { createAccount, fromPublic } from "@nats-io/nkeys";
import { describe, expect, it } from "vitest";
import { fromB64url } from "./b64.js";
import { mintNatsCredential, permissionsFor } from "./nats-credentials.js";
import { readRoutes } from "./routes.js";
import {
  carriesCredentials,
  readTransport,
  routesRefusal,
  sessionRoutes,
} from "./transport.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function account() {
  const key = createAccount();
  const signer = createAccount();
  return {
    account: key.getPublicKey(),
    signingKey: decoder.decode(signer.getSeed()),
    signer: signer.getPublicKey(),
  };
}

function claims(jwt: string): Record<string, unknown> {
  const body = fromB64url(jwt.split(".")[1] ?? "");
  if (!body) throw new Error("not a jwt");
  return JSON.parse(decoder.decode(body));
}

const URL_ = "wss://nats.example.test";

describe("a NATS carrier in the owner's profile", () => {
  it("may name an account to mint for, and a session mode", () => {
    const { account: a, signingKey } = account();
    const read = readTransport({
      carriers: [
        {
          kind: "nats",
          url: URL_,
          mint: { account: a, signingKey },
          session: "always",
        },
      ],
    });
    expect(read.ok).toBe(true);
  });

  it("refuses a signing key beside a login or a credential", () => {
    const { account: a, signingKey } = account();
    const read = readTransport({
      carriers: [
        {
          kind: "nats",
          url: URL_,
          token: "t",
          mint: { account: a, signingKey },
        },
      ],
    });
    expect(read.ok).toBe(false);
  });

  it("refuses a malformed account, signing key, credential or mode", () => {
    for (const carrier of [
      { kind: "nats", url: URL_, mint: { account: "nope", signingKey: "SAX" } },
      { kind: "nats", url: URL_, jwt: "a.b.c" },
      { kind: "nats", url: URL_, session: "sometimes" },
      { kind: "mqtt", url: URL_, session: "always" },
    ])
      expect(readTransport({ carriers: [carrier] }).ok).toBe(false);
  });

  it("counts a static credential as one the link hands out, not a signing key", () => {
    const { account: a, signingKey } = account();
    const minted = readTransport({
      carriers: [{ kind: "nats", url: URL_, mint: { account: a, signingKey } }],
    });
    if (!minted.ok) throw new Error("profile");
    expect(carriesCredentials(minted.transport)).toBe(false);
    expect(routesRefusal(minted.transport)).toBeNull();
  });
});

describe("a link", () => {
  it("never carries a signing key", () => {
    const { account: a, signingKey } = account();
    expect(
      readRoutes({
        carriers: [
          { kind: "nats", url: URL_, mint: { account: a, signingKey } },
        ],
      }),
    ).toBeNull();
  });
});

describe("credentials a session mints", () => {
  it("are a user JWT the signing key signed, for this session's subjects, expiring with it", async () => {
    const mint = account();
    const expiresAt = Date.now() + 30 * 60_000;
    const { jwt, seed } = await mintNatsCredential(
      mint,
      "joiner",
      "TOPIC",
      expiresAt,
    );
    const body = claims(jwt);
    const nats = body.nats as Record<string, unknown>;
    expect(body.iss).toBe(mint.signer);
    expect(body.exp).toBe(Math.ceil(expiresAt / 1000));
    expect(nats.issuer_account).toBe(mint.account);
    expect(nats.type).toBe("user");
    expect(nats.allowed_connection_types).toEqual(["WEBSOCKET"]);
    expect(nats.pub).toEqual({ allow: permissionsFor("joiner", "TOPIC").pub });
    expect(seed).toMatch(/^SU[A-Z2-7]{56}$/);
    const [head, payload, signature] = jwt.split(".");
    const sig = fromB64url(signature ?? "");
    expect(sig).not.toBeNull();
    expect(
      fromPublic(mint.signer).verify(
        encoder.encode(`${head}.${payload}`),
        sig ?? new Uint8Array(),
      ),
    ).toBe(true);
  });

  it("let a joiner touch only the session's own subjects", () => {
    const joiner = permissionsFor("joiner", "T");
    expect(joiner.pub).toEqual(["opensesame.live.T", "opensesame.live.T.>"]);
    expect(joiner.sub).toEqual(joiner.pub);
    expect(joiner.responses).toBeUndefined();
    const owner = permissionsFor("owner", "T");
    expect(owner.sub).toContain("$SRV.>");
    expect(owner.responses).toBe(true);
  });

  it("go one to the link and one to the owner, and the signing key to neither", async () => {
    const mint = account();
    const read = readTransport({
      carriers: [
        {
          kind: "nats",
          url: URL_,
          mint: { account: mint.account, signingKey: mint.signingKey },
        },
      ],
    });
    if (!read.ok) throw new Error("profile");
    const { link, own } = await sessionRoutes(
      read.transport,
      Date.now() + 60_000,
      "TOPIC",
    );
    const linked = link.carriers[0];
    const mine = own[0];
    expect(linked?.jwt).toBeTruthy();
    expect(mine?.jwt).toBeTruthy();
    expect(linked?.jwt).not.toBe(mine?.jwt);
    expect(JSON.stringify({ link, own })).not.toContain(mint.signingKey);
    const nats = claims(linked?.jwt ?? "").nats as Record<string, unknown>;
    expect(nats.resp).toBeUndefined();
    expect(
      readRoutes({ carriers: link.carriers.map((c) => ({ ...c })) }),
    ).not.toBeNull();
  });
});
