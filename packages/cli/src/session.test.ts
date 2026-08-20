import { chmod, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCli } from "./run.js";
import { type JsonObject, overlapCast } from "@opensesame/os-domain";

const ISSUER = "http://127.0.0.1:8788";
let dir = "";
let out = "";
let err = "";

function captureStreams() {
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    out += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    err += String(chunk);
    return true;
  });
}

function sessionFile(): string {
  return join(dir, "identity-session.json");
}

async function writeSession(
  contents: JsonObject,
  mode = 0o600,
): Promise<void> {
  await writeFile(sessionFile(), JSON.stringify(contents), { mode });
  await chmod(sessionFile(), mode);
}

/** Answers discovery, the device endpoints, and `principals/me`. */
function idpFetch(): typeof fetch {
  return overlapCast(vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("openid-configuration")) {
      return new Response(
        JSON.stringify({
          issuer: ISSUER,
          authorization_endpoint: `${ISSUER}/auth`,
          token_endpoint: `${ISSUER}/token`,
          device_authorization_endpoint: `${ISSUER}/device`,
          jwks_uri: `${ISSUER}/jwks`,
        }),
      );
    }
    if (url.endsWith("/device")) {
      return new Response(
        JSON.stringify({
          device_code: "dc",
          user_code: "ABCD-EFGH",
          verification_uri: `${ISSUER}/device`,
          expires_in: 600,
          interval: 1,
        }),
      );
    }
    if (url.endsWith("/token")) {
      return new Response(
        JSON.stringify({
          access_token: "at-1",
          token_type: "Bearer",
          expires_in: 3600,
        }),
      );
    }
    if (url.endsWith("/v1/principals/me")) {
      return new Response(JSON.stringify({ id: "p-1" }), { status: 200 });
    }
    if (url.endsWith("/v1/principals/provisional")) {
      return new Response(
        JSON.stringify({
          principalId: "prn_guest",
          state: "provisional",
          assurance: "provisional",
          sessionId: "ps_1",
          accessToken: "pst_guest",
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
          tokenType: "Bearer",
        }),
        { status: 201 },
      );
    }
    throw new Error(`unexpected ${url}`);
  }));
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "opensesame-cli-"));
  process.env.OPENSESAME_STATE_DIR = dir;
  out = "";
  err = "";
  captureStreams();
});

afterEach(() => {
  vi.restoreAllMocks();
  Reflect.deleteProperty(process.env, "OPENSESAME_STATE_DIR");
});

describe("cli session file", () => {
  it("writes the session so only its owner can read it", async () => {
    const code = await runCli(["login", "--device", "--issuer", ISSUER], {
      fetchImpl: idpFetch(),
      sleep: async () => undefined,
    });
    expect(code).toBe(0);
    const info = await stat(sessionFile());
    expect(info.mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(sessionFile(), "utf8")).accessToken).toBe(
      "at-1",
    );
  });

  it("takes the private bits back from a file left open by an earlier version", async () => {
    await writeSession(
      { accessToken: "old", issuer: ISSUER, clientId: "c" },
      0o644,
    );
    const code = await runCli(["login", "--device", "--issuer", ISSUER], {
      fetchImpl: idpFetch(),
      sleep: async () => undefined,
    });
    expect(code).toBe(0);
    expect((await stat(sessionFile())).mode & 0o777).toBe(0o600);
  });

  it("will not read a session file others can reach", async () => {
    await writeSession(
      { accessToken: "at-1", issuer: ISSUER, clientId: "opensesame-cli" },
      0o644,
    );
    const code = await runCli(["whoami", "--issuer", ISSUER], {
      fetchImpl: idpFetch(),
    });
    expect(code).toBe(1);
    expect(err).toMatch(/readable or writable by others/);
    expect(out).toMatch(/Not authenticated/);
  });

  it("does not send one issuer's token to another", async () => {
    await writeSession({
      accessToken: "at-1",
      issuer: ISSUER,
      clientId: "opensesame-cli",
    });
    const seen: Array<string | null> = [];
    const watchful = overlapCast(vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        seen.push(new Headers(init?.headers).get("authorization"));
        if (String(input).endsWith("/v1/principals/me")) {
          return new Response(JSON.stringify({ id: "p-1" }), { status: 200 });
        }
        throw new Error(`unexpected ${String(input)}`);
      },
    ));

    const elsewhere = await runCli(
      [
        "whoami",
        "--issuer",
        "https://idp.other.test",
        "--api",
        "https://api.other.test",
      ],
      { fetchImpl: watchful },
    );
    expect(elsewhere).toBe(1);
    expect(seen).toHaveLength(0);

    const home = await runCli(["whoami", "--issuer", ISSUER], {
      fetchImpl: watchful,
    });
    expect(home).toBe(0);
    expect(seen).toEqual(["Bearer at-1"]);
  });

  it("login --anonymous mints and stores a provisional guest session", async () => {
    const code = await runCli(["login", "--anonymous", "--issuer", ISSUER], {
      fetchImpl: idpFetch(),
    });
    expect(code).toBe(0);
    const saved = JSON.parse(await readFile(sessionFile(), "utf8"));
    expect(saved.accessToken).toBe("pst_guest");
    expect(saved.anonymous).toBe(true);
    expect(saved.principalId).toBe("prn_guest");
    expect((await stat(sessionFile())).mode & 0o777).toBe(0o600);
    expect(out).toMatch(/guest/i);
  });

  it("logout revokes a guest session server-side and clears the file", async () => {
    await writeSession({
      accessToken: "pst_guest",
      issuer: ISSUER,
      clientId: "opensesame-cli",
      anonymous: true,
      principalId: "prn_guest",
    });
    const seen: Array<{ path: string; auth: string | null }> = [];
    const watchful = overlapCast(vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        seen.push({
          path: new URL(String(input)).pathname,
          auth: new Headers(init?.headers).get("authorization"),
        });
        return new Response(null, { status: 204 });
      },
    ));

    const code = await runCli(["logout", "--issuer", ISSUER], {
      fetchImpl: watchful,
    });
    expect(code).toBe(0);
    expect(seen).toEqual([
      { path: "/v1/principals/provisional/revoke", auth: "Bearer pst_guest" },
    ]);
    await expect(readFile(sessionFile(), "utf8")).rejects.toThrow();
  });

  it("does not reuse a session that has already expired", async () => {
    await writeSession({
      accessToken: "at-1",
      issuer: ISSUER,
      clientId: "opensesame-cli",
      expiresAt: Date.now() - 1000,
    });
    const code = await runCli(["whoami", "--issuer", ISSUER], {
      fetchImpl: idpFetch(),
    });
    expect(code).toBe(1);
    expect(out).toMatch(/Not authenticated/);
  });

  it("keeps the session file when refresh is partitioned", async () => {
    await writeSession({
      accessToken: "at-keep",
      refreshToken: "rt-keep",
      issuer: ISSUER,
      clientId: "opensesame-cli",
      expiresAt: Date.now() - 1000,
    });
    const partitioned = overlapCast(vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }));
    const code = await runCli(["whoami", "--issuer", ISSUER], {
      fetchImpl: partitioned,
    });
    expect(code).toBe(1);
    expect(out).toMatch(/Not authenticated/);
    const saved = JSON.parse(await readFile(sessionFile(), "utf8"));
    expect(saved.accessToken).toBe("at-keep");
    expect(saved.refreshToken).toBe("rt-keep");
  });
});
