import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isJsonObject, isNumber, overlapCast } from "@opensesame/os-domain";
import { expect, it, vi } from "vitest";
import { saveSession } from "./identity-session.js";
import { runCli } from "./run.js";

async function identityFixture(principal: string, token: string) {
  const received: string[] = [];
  const server = createServer((request, response) => {
    received.push(request.headers.authorization ?? "");
    response.setHeader("content-type", "application/json");
    response.statusCode =
      request.headers.authorization === `Bearer ${token}` ? 200 : 401;
    response.end(
      JSON.stringify(
        response.statusCode === 200
          ? { id: principal }
          : { error: "unauthorized" },
      ),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = overlapCast(server.address());
  if (!isJsonObject(address) || !isNumber(address.port))
    throw new Error("expected a TCP listener");
  return {
    issuer: `http://127.0.0.1:${address.port}`,
    received,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

it("never reuses or refreshes a cached customer credential against another issuer", async () => {
  const directory = await mkdtemp(join(tmpdir(), "os-cli-customer-session-"));
  const customerA = await identityFixture(
    "customer-a-principal",
    "customer-a-access",
  );
  const customerB = await identityFixture(
    "customer-b-principal",
    "customer-b-access",
  );
  let output = "";
  let errors = "";
  vi.stubEnv("OPENSESAME_STATE_DIR", directory);
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    output += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    errors += String(chunk);
    return true;
  });
  try {
    await saveSession({
      issuer: customerA.issuer,
      clientId: "opensesame-cli",
      accessToken: "customer-a-access",
      refreshToken: "customer-a-refresh",
      expiresAt: Date.now() + 60_000,
    });
    const args = (issuer: string) => [
      "whoami",
      "--issuer",
      issuer,
      "--api",
      issuer,
    ];
    expect(await runCli(args(customerA.issuer))).toBe(0);
    expect(output).toContain("customer-a-principal");
    expect(await runCli(args(customerB.issuer))).toBe(1);
    expect(customerB.received).toEqual([]);
    expect(await runCli(args(customerA.issuer))).toBe(0);
    await saveSession({
      issuer: customerA.issuer,
      clientId: "opensesame-cli",
      accessToken: "customer-a-access",
      refreshToken: "customer-a-refresh",
      expiresAt: Date.now() - 1,
    });
    expect(await runCli(args(customerB.issuer))).toBe(1);
    expect(customerB.received).toEqual([]);
    await saveSession({
      issuer: customerB.issuer,
      clientId: "opensesame-cli",
      accessToken: "customer-b-access",
      expiresAt: Date.now() + 60_000,
    });
    expect(await runCli(args(customerB.issuer))).toBe(0);
    expect(output).toContain("customer-b-principal");
    expect(customerA.received).toEqual([
      "Bearer customer-a-access",
      "Bearer customer-a-access",
    ]);
    expect(customerB.received).toEqual(["Bearer customer-b-access"]);
    expect(output + errors).not.toContain("customer-a-access");
    expect(output + errors).not.toContain("customer-a-refresh");
    expect(output + errors).not.not.toContain("customer-b-access");
    const path = join(directory, "identity-session.json");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    // The current human-auth cache relies on file permissions, not encryption.
    expect(await readFile(path, "utf8")).not.toContain("customer-b-access");
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await Promise.all([customerA.close(), customerB.close()]);
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
