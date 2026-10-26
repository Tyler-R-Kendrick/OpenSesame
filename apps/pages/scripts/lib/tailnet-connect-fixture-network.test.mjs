/** @vitest-environment node */
import { X509Certificate } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { get as httpsGet } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  fixturePeerTLS,
  fixtureTls,
  proofServer,
} from "./tailnet-connect-fixture-network.mjs";

import { command } from "./tailnet-connect-fixture-process.mjs";

let directory;
let certificates;
let wrongCA;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "tailnet-peer-tls-test-"));
  certificates = await fixturePeerTLS(directory, "127.0.0.1");
  const unrelated = join(directory, "unrelated");
  await mkdir(unrelated);
  const other = await fixtureTls(unrelated);
  wrongCA = await readFile(other.caPath, "utf8");
});
afterAll(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

function readTLS(url, ca) {
  return new Promise((resolve, reject) => {
    const request = httpsGet(
      url,
      {
        ca,
        rejectUnauthorized: true,
        agent: false,
        signal: AbortSignal.timeout(5000),
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.once("error", reject);
        response.once("end", () =>
          resolve({ status: response.statusCode, body }),
        );
      },
    );
    request.once("error", reject);
  });
}

it("retains the default plain HTTP proof response and request inventory", async () => {
  const proof = await proofServer(0);
  try {
    const response = await fetch(`${proof.origin}/proof`, {
      signal: AbortSignal.timeout(5000),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      source: "real-native-tailscale-peer",
      nonce: proof.nonce,
      path: "/proof",
    });
    expect(proof.requests).toEqual([{ method: "GET", path: "/proof" }]);
    expect(proof.stats).toBeNull();
  } finally {
    await proof.close();
  }
});

it("counts real TLS rejection before HTTP for wrong CA and same-CA wrong hostname", async () => {
  const trusted = await proofServer(0, certificates.trusted);
  let wrongHostname;
  try {
    wrongHostname = await proofServer(0, certificates.wrongHostname);
    const response = await readTLS(
      `${trusted.origin}/proof`,
      certificates.caPEM,
    );
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body).nonce).toBe(trusted.nonce);
    expect(trusted.stats.secure).toBe(1);
    expect(trusted.requests).toHaveLength(1);
    const before = { ...trusted.stats };
    await expect(readTLS(`${trusted.origin}/proof`, wrongCA)).rejects.toThrow();
    await expect
      .poll(() => trusted.stats.errors)
      .toBeGreaterThan(before.errors);
    expect(trusted.stats.connections).toBeGreaterThan(before.connections);
    expect(trusted.stats.lastError).toMatch(/^[A-Z0-9_]{1,80}$/);
    expect(trusted.requests).toHaveLength(1);
    await expect(
      readTLS(`${wrongHostname.origin}/proof`, certificates.caPEM),
    ).rejects.toMatchObject({ code: "ERR_TLS_CERT_ALTNAME_INVALID" });
    await expect.poll(() => wrongHostname.stats.errors).toBeGreaterThan(0);
    expect(wrongHostname.stats.connections).toBeGreaterThan(0);
    expect(wrongHostname.stats.lastError).toMatch(/^[A-Z0-9_]{1,80}$/);
    expect(wrongHostname.requests).toEqual([]);
  } finally {
    await wrongHostname?.close();
    await trusted.close();
  }
});

it("issues an explicit signing CA accepted by the native peer trust policy", async () => {
  expect(new X509Certificate(certificates.caPEM).ca).toBe(true);
  const usage = await command("openssl", [
    "x509",
    "-in",
    certificates.trusted.caPath,
    "-noout",
    "-ext",
    "keyUsage",
  ]);
  expect(usage).toContain("Certificate Sign");
});
