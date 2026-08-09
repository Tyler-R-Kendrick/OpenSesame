import { chmod, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCli } from "./run.js";

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
  contents: Record<string, unknown>,
  mode = 0o600,
): Promise<void> {
  await writeFile(sessionFile(), JSON.stringify(contents), { mode });
  await chmod(sessionFile(), mode);
}

/** Answers discovery, the device endpoints, and `principals/me`. */
function idpFetch(): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL) => {
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
        JSON.stringify({ access_token: "at-1", token_type: "Bearer", expires_in: 3600 }),
      );
    }
    if (url.endsWith("/api/v1/principals/me")) {
      return new Response(JSON.stringify({ id: "p-1" }), { status: 200 });
    }
    throw new Error(`unexpected ${url}`);
  }) as unknown as typeof fetch;
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
  delete process.env.OPENSESAME_STATE_DIR;
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
    expect(JSON.parse(await readFile(sessionFile(), "utf8")).accessToken).toBe("at-1");
  });

  it("takes the private bits back from a file left open by an earlier version", async () => {
    await writeSession({ accessToken: "old", issuer: ISSUER, clientId: "c" }, 0o644);
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
    const code = await runCli(["whoami", "--issuer", ISSUER], { fetchImpl: idpFetch() });
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
    const watchful = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(new Headers(init?.headers).get("authorization"));
      if (String(input).endsWith("/api/v1/principals/me")) {
        return new Response(JSON.stringify({ id: "p-1" }), { status: 200 });
      }
      throw new Error(`unexpected ${String(input)}`);
    }) as unknown as typeof fetch;

    const elsewhere = await runCli(
      ["whoami", "--issuer", "https://idp.other.test", "--api", "https://api.other.test"],
      { fetchImpl: watchful },
    );
    expect(elsewhere).toBe(1);
    expect(seen).toHaveLength(0);

    const home = await runCli(["whoami", "--issuer", ISSUER], { fetchImpl: watchful });
    expect(home).toBe(0);
    expect(seen).toEqual(["Bearer at-1"]);
  });

  it("does not reuse a session that has already expired", async () => {
    await writeSession({
      accessToken: "at-1",
      issuer: ISSUER,
      clientId: "opensesame-cli",
      expiresAt: Date.now() - 1000,
    });
    const code = await runCli(["whoami", "--issuer", ISSUER], { fetchImpl: idpFetch() });
    expect(code).toBe(1);
    expect(out).toMatch(/Not authenticated/);
  });
});
