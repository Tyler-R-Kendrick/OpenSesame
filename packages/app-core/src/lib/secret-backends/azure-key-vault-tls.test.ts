import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { tlsFetch } from "../native-s3-backup.test-support.js";
import {
  AZURE_FIXTURE_TOKEN,
  azureHttpFixture,
} from "./azure-key-vault-http.test-support.js";
import { createAzureKeyVaultSecretBackend } from "./azure-key-vault.js";
import type { SecretBackendConfiguration } from "./types.js";

const directory = mkdtempSync(join(tmpdir(), "azure-secrets-tls-"));
let certificate: { key: Buffer; cert: Buffer };
let wrongRoot: Buffer;
const cleanups: (() => Promise<void>)[] = [];
function makeCertificate(name: string) {
  const key = join(directory, `${name}.key`);
  const cert = join(directory, `${name}.crt`);
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
    { stdio: "ignore" },
  );
  return { key: readFileSync(key), cert: readFileSync(cert) };
}
beforeAll(() => {
  certificate = makeCertificate("owned");
  wrongRoot = makeCertificate("unrelated").cert;
});
afterAll(() => rmSync(directory, { recursive: true, force: true }));
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
function configuration(baseUrl: string): SecretBackendConfiguration {
  return {
    providerId: "azure-sm",
    name: "Owned Azure TLS vault",
    mode: "local",
    baseUrl,
    identityUrl: "",
    token: AZURE_FIXTURE_TOKEN,
    vaultId: "",
    projectId: "",
    organizationId: "",
    environment: "",
    secretPath: "",
    clientId: "",
    clientSecret: "",
    passwordListId: "",
    fileFormat: "",
  };
}
async function setup(observe?: (response: Response) => void) {
  const fixture = await azureHttpFixture(certificate);
  cleanups.push(async () => {
    await fixture.close();
    expect(fixture.errors).toEqual([]);
  });
  const fetch = tlsFetch(certificate.cert);
  const backend = createAzureKeyVaultSecretBackend({
    ...fixture.transport,
    fetch: async (input, init) => {
      const response = await fetch(input, init);
      observe?.(response);
      return response;
    },
  });
  return { fixture, backend, config: configuration(fixture.origin) };
}
function value(secret = "owned-TLS-value") {
  return { name: "owned-tls", kind: "secret" as const, secret, notes: "" };
}
async function physicallyClosed(closed: Promise<void>) {
  await expect(
    Promise.race([
      closed,
      new Promise<never>((_, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("Original Azure TLS socket did not close")),
          2000,
        );
        closed.finally(() => clearTimeout(timeout));
      }),
    ]),
  ).resolves.toBeUndefined();
}
it("uses verified TLS for versioned native CRUD and independently checks the wire contract", async () => {
  const { fixture, backend, config } = await setup();
  const session = await backend.authenticate(config);
  if (!backend.createItem || !backend.updateItem || !backend.deleteItem)
    throw new Error("Azure mutations missing");
  const created = await backend.createItem(value(), session);
  expect(created.secret).toBe("owned-TLS-value");
  expect(await backend.getNotes(created.id, session)).toBe(created.secret);
  const original = fixture.versions.get(created.name)?.[0];
  expect(original).toBeDefined();
  await backend.updateItem(created.id, value("changed-TLS-value"), session);
  expect(fixture.versions.get(created.name)).toHaveLength(2);
  expect(original?.value).toBe("owned-TLS-value");
  expect((await backend.getItem(created.id, session)).secret).toBe(
    "changed-TLS-value",
  );
  expect(await backend.listItems(session)).toEqual([
    { id: created.id, name: created.name, kind: "secret" },
  ]);
  await backend.deleteItem(created.id, session);
  expect(await backend.listItems(session)).toEqual([]);
  expect(fixture.deleted.get(created.name)).toHaveLength(2);
  expect(fixture.requests.some((request) => request.method === "PUT")).toBe(
    true,
  );
  expect(fixture.requests.some((request) => request.method === "DELETE")).toBe(
    true,
  );
  expect(
    fixture.requests.every((request) =>
      request.path.includes("api-version=2025-07-01"),
    ),
  ).toBe(true);
  await backend.disconnect(session);
});
it("refuses an unrelated CA before the Azure service receives a credential request", async () => {
  const { fixture, config } = await setup();
  const backend = createAzureKeyVaultSecretBackend({
    ...fixture.transport,
    fetch: tlsFetch(wrongRoot),
  });
  await expect(backend.authenticate(config)).rejects.toMatchObject({
    code: "network",
  });
  expect(fixture.requests).toEqual([]);
});
it("physically closes the original held TLS read before release and preserves an independent session", async () => {
  const { fixture, backend, config } = await setup();
  fixture.seed("owned-tls", "held-value");
  const original = await backend.authenticate(config);
  const independent = await backend.authenticate(config);
  const held = fixture.holdNext();
  const pending = backend.getItem("owned-tls", original);
  const refusal = expect(pending).rejects.toBeInstanceOf(Error);
  await held.arrived;
  await backend.disconnect(original);
  await refusal;
  await physicallyClosed(held.closed);
  expect((await backend.getItem("owned-tls", independent)).secret).toBe(
    "held-value",
  );
  held.release();
  await expect(backend.listItems(original)).rejects.toMatchObject({
    code: "authentication",
  });
  await backend.disconnect(independent);
});
it("physically drains pending TLS authentication when its captured owner ends", async () => {
  const { fixture, backend, config } = await setup();
  const held = fixture.holdNext();
  const pending = backend.authenticate(config);
  const refusal = expect(pending).rejects.toMatchObject({ code: "stale" });
  await held.arrived;
  fixture.controller.abort();
  await refusal;
  await physicallyClosed(held.closed);
  const before = fixture.requests.length;
  await expect(backend.authenticate(config)).rejects.toMatchObject({
    code: "stale",
  });
  expect(fixture.requests).toHaveLength(before);
  held.release();
});
it("rejects wrong-audience and HTTP200 error envelopes without admitting a session", async () => {
  const { fixture, backend, config } = await setup();
  await expect(
    backend.authenticate({ ...config, token: "wrong-audience-token" }),
  ).rejects.toMatchObject({ code: "authentication", status: 401 });
  fixture.faultNext({ body: { error: { code: "Forbidden" } } });
  await expect(backend.authenticate(config)).rejects.toMatchObject({
    code: "response",
  });
  const session = await backend.authenticate(config);
  expect(await backend.listItems(session)).toEqual([]);
  await backend.disconnect(session);
});

it("cancels the original partially received TLS body on exact-session disconnect", async () => {
  let response: Response | undefined;
  const { fixture, backend, config } = await setup((value) => {
    response = value;
  });
  fixture.seed("owned-tls", "still-owned");
  const original = await backend.authenticate(config);
  const independent = await backend.authenticate(config);
  response = undefined;
  const held = fixture.holdNext(200);
  const pending = backend.getItem("owned-tls", original);
  const refused = expect(pending).rejects.toBeInstanceOf(Error);
  try {
    await held.arrived;
    await vi.waitFor(() => expect(response?.bodyUsed).toBe(true));
    await backend.disconnect(original);
    await refused;
    await physicallyClosed(held.closed);
    expect((await backend.getItem("owned-tls", independent)).secret).toBe(
      "still-owned",
    );
    await backend.disconnect(independent);
  } finally {
    held.release();
  }
});
it("cancels partially received authentication bodies on captured-owner withdrawal", async () => {
  let response: Response | undefined;
  const { fixture, backend, config } = await setup((value) => {
    response = value;
  });
  const held = fixture.holdNext(200);
  const pending = backend.authenticate(config);
  const refused = expect(pending).rejects.toMatchObject({ code: "stale" });
  try {
    await held.arrived;
    await vi.waitFor(() => expect(response?.bodyUsed).toBe(true));
    fixture.controller.abort();
    await refused;
    await physicallyClosed(held.closed);
    const count = fixture.requests.length;
    await expect(backend.authenticate(config)).rejects.toMatchObject({
      code: "stale",
    });
    expect(fixture.requests).toHaveLength(count);
  } finally {
    held.release();
  }
});
it.each([401, 409, 429, 500])(
  "retires unfinished HTTP%s error bodies without awaiting provider completion",
  async (status) => {
    const { fixture, backend, config } = await setup();
    const held = fixture.holdNext(status);
    const pending = backend.authenticate(config);
    const refused = expect(pending).rejects.toMatchObject({
      code: status === 401 ? "authentication" : "response",
      status,
      message: `Azure request failed (HTTP ${status}).`,
    });
    try {
      await held.arrived;
      await refused;
      await physicallyClosed(held.closed);
      expect(fixture.requests).toHaveLength(1);
      const session = await backend.authenticate(config);
      expect(await backend.listItems(session)).toEqual([]);
      await backend.disconnect(session);
    } finally {
      held.release();
    }
  },
);
it("cancels an unfinished HTTP403 classification body when its captured owner ends", async () => {
  let response: Response | undefined;
  const { fixture, backend, config } = await setup((value) => {
    response = value;
  });
  const held = fixture.holdNext(403);
  const pending = backend.authenticate(config);
  const refused = expect(pending).rejects.toMatchObject({ code: "stale" });
  try {
    await held.arrived;
    await vi.waitFor(() => expect(response?.bodyUsed).toBe(true));
    fixture.controller.abort();
    await refused;
    await physicallyClosed(held.closed);
    expect(fixture.requests).toHaveLength(1);
  } finally {
    held.release();
  }
});
