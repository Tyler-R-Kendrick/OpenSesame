import { chmod, mkdtemp, rmdir, symlink, unlink } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { exchangeOnSocket } from "./uds.js";

describe("agent Unix transport", () => {
  it("refuses relative and URL-shaped socket paths before connection", async () => {
    for (const path of ["relative.sock", "http://localhost", "x".repeat(257)]) {
      await expect(exchangeOnSocket(path, "{}")).rejects.toThrow();
    }
  });

  it("uses only the fixed UDS exchange path, bounds responses and refuses aliases", async () => {
    const dir = await mkdtemp(join(tmpdir(), "os-agent-"));
    const socket = join(dir, "daemon.sock");
    const alias = join(dir, "alias.sock");
    let oversized = false;
    const requests: string[] = [];
    const server = createServer((req, res) => {
      requests.push(`${req.method} ${req.url}`);
      expect(req.headers.authorization).toBeUndefined();
      expect(req.headers["x-opensesame-operator"]).toBeUndefined();
      res.end(oversized ? "x".repeat(8193) : '{"ok":true}');
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socket, resolve);
      });
      await chmod(socket, 0o600);
      expect(await exchangeOnSocket(socket, "{}")).toBe('{"ok":true}');
      expect(requests).toEqual(["POST /v1/agent-capabilities/token"]);
      await symlink(socket, alias);
      await expect(exchangeOnSocket(alias, "{}")).rejects.toThrow();
      await chmod(socket, 0o666);
      await expect(exchangeOnSocket(socket, "{}")).rejects.toThrow();
      await chmod(socket, 0o600);
      oversized = true;
      await expect(exchangeOnSocket(socket, "{}")).rejects.toThrow();
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await unlink(alias).catch(() => undefined);
      await unlink(socket).catch(() => undefined);
      await rmdir(dir);
    }
  });
});
