import { describe, expect, it } from "vitest";
import { createSecretBackendSessions } from "./sessions.js";

describe("opaque secret backend sessions", () => {
  it("rejects copied, revoked and foreign handles without exposing credentials", () => {
    const sessions = createSecretBackendSessions<{ token: string }>("fixture");
    const session = sessions.create({ token: "scoped-fixture" });
    expect(JSON.stringify(session)).not.toContain("scoped-fixture");
    expect(sessions.read(session).token).toBe("scoped-fixture");
    expect(() => sessions.read({ ...session })).toThrow();
    const foreign = createSecretBackendSessions<object>("fixture").create({});
    expect(() => sessions.read(foreign)).toThrow();
    sessions.remove(session);
    expect(() => sessions.read(session)).toThrow();
  });
});
