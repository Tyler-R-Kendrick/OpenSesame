/** Owned full Key Vault TLS protocol; no production browser/provider network. */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { azureSecretsKeyFlows } from "../native-azure-secrets.js";
import type { NativeProviderTransport } from "../native-connector-transport.js";
import { tlsFetch } from "../native-s3-backup.test-support.js";
import {
  AZURE_FIXTURE_TOKEN,
  azureHttpFixture,
} from "../secret-backends/azure-key-vault-http.test-support.js";
import { runtimeFixture } from "../secret-backends/runtime.test-support.js";

export async function azureCrudOracle() {
  const directory = mkdtempSync(join(tmpdir(), "azure-crud-tls-"));
  const key = join(directory, "key.pem");
  const cert = join(directory, "cert.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "2",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
      "-keyout",
      key,
      "-out",
      cert,
    ],
    { stdio: "ignore", timeout: 10000 },
  );
  const service = await azureHttpFixture({
    key: readFileSync(key),
    cert: readFileSync(cert),
  });
  const transport: NativeProviderTransport = {
    ...service.transport,
    fetch: tlsFetch(readFileSync(cert)),
    supportsNativeOrigin: (origin) => origin === service.origin,
  };
  const draft = {
    providerId: "azure-sm",
    displayName: "Owned Azure vault",
    parameters: { vault_url: service.origin },
    credentials: { token: AZURE_FIXTURE_TOKEN },
  };
  return {
    service,
    transport,
    draft,
    async close() {
      await service.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
export async function azureSavedFixture() {
  const disk = await runtimeFixture();
  const oracle = await azureCrudOracle();
  const saved = await azureSecretsKeyFlows.configure(
    oracle.draft,
    oracle.transport,
  );
  return {
    ...oracle,
    disk,
    saved,
    async close() {
      await oracle.close();
      await disk.close();
    },
  };
}
export async function azureSocketClosed(closed: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      closed,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Azure socket did not close before2s")),
          2000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
