/**
 * The reference server a live session mints for (ADR 0167): operator mode,
 * the accounts preloaded, the live account trusting the signing key it hands
 * back — and that key nowhere in the configuration. A real nats-server reads
 * it in verify:live-join.
 */
import { fromPublic } from "@nats-io/nkeys";
import { describe, expect, it } from "vitest";
import { fromB64url } from "./b64.js";
import { keyFromSeed } from "./nats-jwt.js";
import { liveNatsOperator } from "./nats-operator.js";
import { isAccountKey, isAccountSeed } from "./nats-route.js";

const decoder = new TextDecoder();
const encoder = new TextEncoder();

function claims(jwt: string): Record<string, unknown> {
  return JSON.parse(
    decoder.decode(fromB64url(jwt.split(".")[1] ?? "") ?? new Uint8Array()),
  );
}

function verified(jwt: string, issuer: string): boolean {
  const [head, body, signature] = jwt.split(".");
  return fromPublic(issuer).verify(
    encoder.encode(`${head}.${body}`),
    fromB64url(signature ?? "") ?? new Uint8Array(),
  );
}

describe("the live-session server configuration", () => {
  it("trusts the account signing key it hands back, and does not hold it", async () => {
    const made = await liveNatsOperator({ websocket: "127.0.0.1:4223" });
    expect(isAccountKey(made.mint.account)).toBe(true);
    expect(isAccountSeed(made.mint.signingKey)).toBe(true);
    expect(made.config).not.toContain(made.mint.signingKey);
    expect(made.config).not.toContain(made.operatorSeed);
    expect(made.config).toContain("resolver: MEMORY");
    expect(made.config).toContain("no_tls: true");
    const operatorJwt = /^operator: (\S+)$/m.exec(made.config)?.[1] ?? "";
    const operator = keyFromSeed(made.operatorSeed).getPublicKey();
    expect(verified(operatorJwt, operator)).toBe(true);
    const accountJwt =
      new RegExp(`^  ${made.mint.account}: (\\S+)$`, "m").exec(
        made.config,
      )?.[1] ?? "";
    expect(verified(accountJwt, operator)).toBe(true);
    const nats = claims(accountJwt).nats as Record<string, unknown>;
    expect(nats.signing_keys).toEqual([
      keyFromSeed(made.mint.signingKey).getPublicKey(),
    ]);
    expect(made.watcher).toBeUndefined();
  });

  it("speaks wss when given a certificate", async () => {
    const made = await liveNatsOperator({
      websocket: "0.0.0.0:8443",
      tls: { cert: "/etc/nats/live.crt", key: "/etc/nats/live.key" },
    });
    expect(made.config).toContain('cert_file: "/etc/nats/live.crt"');
    expect(made.config).not.toContain("no_tls");
  });
});
