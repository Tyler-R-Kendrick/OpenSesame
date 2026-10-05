import { createHash } from "node:crypto";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { describe, expect, it } from "vitest";
import {
  type AccountSecretCodec,
  sealedAccountAdapter,
} from "../account-secret-adapter.js";

const codec: AccountSecretCodec = {
  lookup: (purpose, value) =>
    createHash("sha256")
      .update(JSON.stringify([purpose, value]))
      .digest("hex"),
  seal: (purpose, owner, value) =>
    Buffer.from(JSON.stringify([purpose, owner, value])).toString("base64url"),
  open(purpose, owner, value) {
    const [storedPurpose, storedOwner, token] = JSON.parse(
      Buffer.from(value, "base64url").toString(),
    );
    if (storedPurpose !== purpose || storedOwner !== owner)
      throw new Error("wrong context");
    return token;
  },
};

function fixture() {
  const rows = { user: [], session: [], account: [], verification: [] };
  const auth = betterAuth({
    baseURL: "http://127.0.0.1:8788",
    secret: "session-test-secret-with-enough-entropy",
    database: sealedAccountAdapter(memoryAdapter(rows), codec),
    session: {
      additionalFields: {
        sealedToken: {
          type: "string",
          required: false,
          input: false,
          returned: false,
        },
      },
    },
  });
  return { rows, auth };
}

describe("BetterAuth session envelope adapter", () => {
  it("supports real session creation, indexed lookup, lists, updates, and revocation", async () => {
    const { rows, auth } = fixture();
    const { internalAdapter } = await auth.$context;
    const user = await internalAdapter.createUser({
      name: "Alice",
      email: "alice@example.test",
      emailVerified: true,
    });
    const session = await internalAdapter.createSession(user.id);
    expect(JSON.stringify(rows.session)).not.toContain(session.token);
    expect(
      (await internalAdapter.findSession(session.token))?.session.token,
    ).toBe(session.token);
    const indexed = codec.lookup("better_auth_sessions.token", session.token);
    expect(await internalAdapter.findSession(indexed)).toBeNull();
    expect((await internalAdapter.listSessions(user.id))[0]?.token).toBe(
      session.token,
    );
    expect(
      (await internalAdapter.findSessions([session.token]))[0]?.session.token,
    ).toBe(session.token);
    const update = await internalAdapter.updateSession(session.token, {
      expiresAt: new Date(Date.now() + 60_000),
    });
    expect(update?.token).toBe(session.token);
    await internalAdapter.deleteSession(session.token);
    expect(await internalAdapter.findSession(session.token)).toBeNull();
    const fresh = await internalAdapter.createSession(user.id);
    await internalAdapter.deleteSessions([fresh.token]);
    expect(await internalAdapter.listSessions(user.id)).toEqual([]);
  });
});
