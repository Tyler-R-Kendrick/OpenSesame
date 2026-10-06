import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer } from "node:https";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
interface SocketResult {
  stdout: string;
  code: number;
}
async function socketChild(
  port: number,
  maxBytes = 65536,
  timeoutMs = 15000,
): Promise<SocketResult> {
  return new Promise((finish, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--import",
        resolve("node_modules/tsx/dist/loader.mjs"),
        resolve("src/fixtures/password-agent/request-socket.ts"),
        String(port),
        String(maxBytes),
        String(timeoutMs),
      ],
      {
        env: {
          ...process.env,
          NODE_EXTRA_CA_CERTS: resolve(
            "src/fixtures/password-agent/request-cert.pem",
          ),
        },
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => finish({ stdout, code: code ?? 1 }));
  });
}
describe("real private request socket", { timeout: 60000 }, () => {
  it("pins real TLS to validated address with original hostname and never follows redirect", async () => {
    let calls = 0;
    let authorization: string | undefined;
    let hostname: string | undefined;
    const server = createServer(
      {
        key: await readFile("src/fixtures/password-agent/request-key.pem"),
        cert: await readFile("src/fixtures/password-agent/request-cert.pem"),
      },
      (incoming, response) => {
        calls++;
        authorization = incoming.headers.authorization;
        hostname = incoming.headers.host;
        response.writeHead(302, { Location: "https://localhost/private" });
        response.end("private-response-canary");
      },
    );
    await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
    const address = z
      .object({ port: z.number().int().positive() })
      .parse(server.address());
    try {
      const result = await socketChild(address.port);
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ status: 302, bytes: 23 });
      expect(authorization).toBe("Bearer private-canary");
      expect(hostname).toBe(`request.example:${address.port}`);
      expect(calls).toBe(1);
      expect(result.stdout).not.toContain("private-response-canary");
    } finally {
      await new Promise<void>((finish) => server.close(() => finish()));
    }
  });
  it("enforces real socket response byte and whole-request time limits without retry", async () => {
    let calls = 0;
    const server = createServer(
      {
        key: await readFile("src/fixtures/password-agent/request-key.pem"),
        cert: await readFile("src/fixtures/password-agent/request-cert.pem"),
      },
      (_incoming, response) => {
        calls++;
        if (calls === 1) response.end("oversized-private-response");
      },
    );
    await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
    const address = z
      .object({ port: z.number().int().positive() })
      .parse(server.address());
    try {
      expect(JSON.parse((await socketChild(address.port, 3)).stdout)).toEqual({
        error: true,
      });
      expect(
        JSON.parse((await socketChild(address.port, 65536, 1500)).stdout),
      ).toEqual({ error: true });
      expect(calls).toBe(2);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((finish) => server.close(() => finish()));
    }
  });
});
