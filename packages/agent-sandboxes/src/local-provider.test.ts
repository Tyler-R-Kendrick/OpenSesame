import { ChildProcess, type SpawnOptions } from "node:child_process";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { LocalSandboxProvider } from "./local-provider.js";
import { allowedDomainsFor, sandboxOrigin } from "./types.js";

function fakeSpawn() {
  return vi.fn(
    (_executable: string, _args: readonly string[], _options: SpawnOptions) => {
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const stdin = new PassThrough();
      const stdio: [PassThrough, PassThrough, PassThrough] = [
        stdin,
        stdout,
        stderr,
      ];
      const child = Object.assign(new ChildProcess(), {
        stdin,
        stdout,
        stderr,
        stdio,
        kill: vi.fn(),
      });
      process.nextTick(() => {
        child.stderr.end("");
        child.stdout.end("");
        child.emit("close", 0);
      });
      return child;
    },
  );
}

describe("LocalSandboxProvider", () => {
  it("allocates an ephemeral session with an origin-derived allowlist", async () => {
    const provider = new LocalSandboxProvider({ spawn: fakeSpawn() });
    const sandbox = await provider.allocate({
      origin: "https://accounts.example.test",
      extraAllowedDomains: ["idp.example.test"],
    });
    expect(sandbox.provider).toBe("local");
    expect(sandbox.session).toMatch(/^cua1-/u);
    expect(sandbox.allowedDomains).toEqual([
      "accounts.example.test",
      "idp.example.test",
    ]);
    await sandbox.close();
  });

  it("returns a policy-bound session handle that can be reused for resume", async () => {
    const provider = new LocalSandboxProvider({ spawn: fakeSpawn() });
    const sandbox = await provider.allocate({
      origin: "https://accounts.example.test",
      extraAllowedDomains: ["idp.example.test", "mail.example.test"],
      session: "cua-run-1",
    });
    const resumed = await provider.allocate({
      origin: "https://accounts.example.test/another-path",
      extraAllowedDomains: ["mail.example.test", "idp.example.test"],
      session: sandbox.session,
    });
    const sameStableName = await provider.allocate({
      origin: "https://accounts.example.test",
      extraAllowedDomains: ["idp.example.test", "mail.example.test"],
      session: "cua-run-1",
    });
    const differentPolicy = await provider.allocate({
      origin: "https://other.example.test",
      extraAllowedDomains: ["idp.example.test", "mail.example.test"],
      session: "cua-run-1",
    });
    expect(sandbox.session).toMatch(
      /^cua1-[A-Za-z0-9_-]{22}-[A-Za-z0-9_-]{22}$/u,
    );
    expect(resumed.session).toBe(sandbox.session);
    expect(sameStableName.session).toBe(sandbox.session);
    expect(differentPolicy.session).not.toBe(sandbox.session);
    await resumed.close();
  });

  it("refuses resuming a session under a different origin or domain policy", async () => {
    const provider = new LocalSandboxProvider({ spawn: fakeSpawn() });
    const sandbox = await provider.allocate({
      origin: "https://accounts.example.test",
      extraAllowedDomains: ["idp.example.test"],
      session: "cua-run-1",
    });
    for (const request of [
      {
        origin: "http://accounts.example.test",
        extraAllowedDomains: ["idp.example.test"],
      },
      {
        origin: "https://accounts.example.test:8443",
        extraAllowedDomains: ["idp.example.test"],
      },
      {
        origin: "https://other.example.test",
        extraAllowedDomains: ["idp.example.test"],
      },
      {
        origin: "https://accounts.example.test",
        extraAllowedDomains: ["attacker.example.test"],
      },
    ]) {
      await expect(
        provider.allocate({ ...request, session: sandbox.session }),
      ).rejects.toThrow("does not match the allocation policy");
    }
    await expect(
      provider.allocate({
        origin: "https://accounts.example.test",
        session: "cua1-invalid",
      }),
    ).rejects.toThrow("does not match the allocation policy");
    await sandbox.close();
  });

  it("rejects credentialed and non-HTTP origins", async () => {
    const provider = new LocalSandboxProvider({ spawn: fakeSpawn() });
    await expect(
      provider.allocate({
        origin: "https://user:pass@accounts.example.test",
      }),
    ).rejects.toThrow("credential-free");
    await expect(
      provider.allocate({ origin: "file:///etc/passwd" }),
    ).rejects.toThrow("credential-free");
    expect(() => sandboxOrigin("https://a:b@x.test")).toThrow(
      "credential-free",
    );
    expect(() =>
      allowedDomainsFor({
        origin: "https://x.test",
        extraAllowedDomains: ["bad..domain"],
      }),
    ).toThrow("invalid");
  });
});
