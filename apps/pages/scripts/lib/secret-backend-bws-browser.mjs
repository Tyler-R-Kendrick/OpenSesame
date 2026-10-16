/** Official browser WASM/worker against independently encrypted Node HTTP responses. */
import { expect } from "@playwright/test";
import {
  accessToken,
  secretsManagerFixture,
} from "../../../../packages/app-core/src/lib/secret-backends/bitwarden-secrets.test-support.ts";
import { unlockWithPin } from "./pages-journey.mjs";
import {
  backendCrud,
  connectBackend,
  disconnectBackend,
  openBackend,
  saveBackend,
} from "./secret-backend-browser.mjs";

export const startBrowserSecretsManager = () => secretsManagerFixture(41906);
export async function secretsManagerBrowser(
  page,
  { base, server, presets, width, check },
) {
  const preset = presets.find((entry) => entry.providerId === "bitwarden-sm");
  await openBackend(page, base, preset);
  await page
    .getByLabel("API base URL", { exact: true })
    .fill(`${server.url}/api`);
  await page
    .getByLabel("Identity API URL", { exact: true })
    .fill(`${server.url}/identity`);
  await page.getByLabel("Access token", { exact: true }).fill(accessToken);
  await page
    .getByLabel("Organization ID", { exact: true })
    .fill(server.organizationId);
  await page.getByLabel("Project ID", { exact: true }).fill(server.projectId);
  await saveBackend(page);
  await page.reload({ waitUntil: "networkidle" });
  await unlockWithPin(page);
  await openBackend(page, base, preset);
  await expect(page.getByLabel("API base URL", { exact: true })).toHaveValue(
    `${server.url}/api`,
  );
  await connectBackend(page);
  const before = server.requests.length;
  const name = `browser-bws-${width}`;
  await backendCrud(page, {
    name,
    kind: "secret",
    width,
    origin: new URL(page.url()).origin,
    check,
  });
  const writes = server.requests
    .slice(before)
    .filter(
      (request) =>
        ["POST", "PUT"].includes(request.method) &&
        request.path !== "/api/secrets/delete",
    );
  expect(writes.length).toBeGreaterThanOrEqual(2);
  for (const request of writes) {
    expect(request.body).not.toContain(name);
    expect(request.body).not.toContain(`browser-secret-${name}`);
    expect(request.body).not.toContain("Browser notes for");
    const body = JSON.parse(request.body);
    for (const field of ["key", "value", "note"])
      expect(body[field]).toMatch(/^2\.[^|]+\|[^|]+\|[^|]+$/u);
  }
  expect(server.items.size).toBe(0);
  check(
    true,
    `${width}: official BWS browser worker/WASM performs independently decrypted AES-CBC/HMAC CRUD with encrypted names, values and notes on the wire`,
  );
  check(
    server.preflights.length > 0,
    `${width}: BWS SDK main-thread leased fetch performs actual browser CORS preflights`,
  );
  await disconnectBackend(page);
}

export function secretsManagerEvidence(server) {
  return {
    endpoint: server.url,
    requests: server.requests.map(({ method, path, headers }) => ({
      method,
      path,
      origin: headers.origin,
      credentialPresent: !!headers.authorization,
    })),
    preflights: server.preflights.map(({ method, path, headers }) => ({
      method,
      path,
      origin: headers.origin,
    })),
    plaintextItemsRemaining: server.items.size,
  };
}
