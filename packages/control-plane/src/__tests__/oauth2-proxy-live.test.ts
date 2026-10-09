/**
 * Live oauth2-proxy v7.8.2 binary against a running Identity issuer.
 *
 * The generated recipe omits client_secret (public PKCE). oauth2-proxy still
 * requires a non-empty --client-secret flag; that placeholder is a CLI quirk,
 * not a credential written into the recipe.
 */
import { spawn } from "node:child_process";
import { constants, accessSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isString, overlapCast } from "@opensesame/os-domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { startServer } from "../server.js";
import { freePort, onFreePort } from "./free-port.js";

type Started = Awaited<ReturnType<typeof startServer>>;

const PINNED = "v7.8.2";

const CANDIDATE_BINS = [
  process.env.OAUTH2_PROXY_BIN,
  "/tmp/oauth2-proxy-smoke/oauth2-proxy-v7.8.2.linux-arm64/oauth2-proxy",
  "/tmp/oauth2-proxy-smoke/oauth2-proxy",
].filter((p): p is string => isString(p) && p.length > 0);

function resolveProxyBin(): string | null {
  for (const path of CANDIDATE_BINS) {
    try {
      accessSync(path, constants.X_OK);
      return path;
    } catch {
      // try next
    }
  }
  return null;
}

/** Mirrors apps/pages oauth2ProxyConfig — keep fields in lockstep with the recipe. */
type PublicPkceCfgInput = {
  issuer: string;
  clientId: string;
  redirectUrl: string;
};

function publicPkceCfg(input: PublicPkceCfgInput): string {
  return `# oauth2-proxy ${PINNED}
# Public PKCE client. Do not put a client secret in this file.
provider = "oidc"
oidc_issuer_url = "${input.issuer}"
client_id = "${input.clientId}"
redirect_url = "${input.redirectUrl}"
code_challenge_method = "S256"
oidc_email_claim = "email"
email_domains = "*"
skip_provider_button = true
`;
}

async function waitForHttp(url: string, timeoutMs: number): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let lastErr = "timeout";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { redirect: "manual" });
      return res.status;
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  throw new Error(`HTTP not ready at ${url}: ${lastErr}`);
}

describe(`oauth2-proxy ${PINNED} live binary`, () => {
  const proxyBin = resolveProxyBin();
  let started: Started;
  let base = "";
  let proxy: ReturnType<typeof spawn> | null = null;
  const workDir = mkdtempSync(join(tmpdir(), "oauth2-proxy-live-"));

  beforeAll(async () => {
    if (!proxyBin) {
      return;
    }
    const { startServer: start } = await import("../server.js");
    started = await onFreePort((port) =>
      start({
        config: {
          host: "127.0.0.1",
          port,
          publicUrl: `http://127.0.0.1:${port}`,
          issuer: `http://127.0.0.1:${port}`,
        },
      }),
    );
    base = `http://127.0.0.1:${started.port}`;
  }, 60_000);

  afterAll(async () => {
    if (proxy && !proxy.killed) {
      proxy.kill("SIGTERM");
    }
    if (started) {
      await new Promise<void>((resolve, reject) => {
        started.server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });

  it("loads the public-PKCE recipe and serves /ping against Identity discovery", async () => {
    if (!proxyBin) {
      if (process.env.OPENSESAME_REQUIRE_OAUTH2_PROXY === "1") {
        throw new Error(
          `oauth2-proxy ${PINNED} binary not found. Set OAUTH2_PROXY_BIN.`,
        );
      }
      console.warn(
        `[skip] oauth2-proxy ${PINNED} binary not found; set OAUTH2_PROXY_BIN to run live smoke`,
      );
      return;
    }

    const discoveryRes = await fetch(
      `${base}/.well-known/openid-configuration`,
    );
    expect(discoveryRes.status).toBe(200);
    const discovery = overlapCast(await discoveryRes.json());
    expect(isString(discovery.issuer) && discovery.issuer.length > 0).toBe(
      true,
    );
    expect(discovery.code_challenge_methods_supported).toContain("S256");

    const proxyPort = await freePort();
    const redirectUrl = `http://127.0.0.1:${proxyPort}/oauth2/callback`;
    const cfgInput = {
      issuer: String(discovery.issuer),
      clientId: "oauth2-proxy-live",
      redirectUrl,
    } satisfies PublicPkceCfgInput;
    const cfg = publicPkceCfg(cfgInput);
    expect(cfg).not.toMatch(/^\s*client_secret\s*=/im);
    expect(cfg).toContain(PINNED);

    const cfgPath = join(workDir, "oauth2-proxy.cfg");
    writeFileSync(cfgPath, cfg, "utf8");

    const proxyLog: string[] = [];
    proxy = spawn(
      proxyBin,
      [
        `--config=${cfgPath}`,
        // v7.8.2 requires a non-empty value even for public PKCE; not in recipe.
        "--client-secret=unused-public-pkce-placeholder",
        "--cookie-secret=0123456789abcdef0123456789abcdef",
        `--http-address=127.0.0.1:${proxyPort}`,
        "--upstream=http://127.0.0.1:9",
        "--email-domain=*",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    proxy.stdout?.on("data", (chunk: Buffer) => {
      proxyLog.push(chunk.toString("utf8"));
    });
    proxy.stderr?.on("data", (chunk: Buffer) => {
      proxyLog.push(chunk.toString("utf8"));
    });

    try {
      const status = await waitForHttp(
        `http://127.0.0.1:${proxyPort}/ping`,
        15_000,
      );
      expect(status).toBe(200);
    } catch (err) {
      throw new Error(`${String(err)}\nproxy log:\n${proxyLog.join("")}`);
    }
  }, 60_000);
});
