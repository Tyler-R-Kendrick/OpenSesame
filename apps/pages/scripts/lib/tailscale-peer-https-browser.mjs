/** Actual emitted Worker GET + shared peer trust editor + real TLS peer oracle. */
import { expect } from "@playwright/test";
import { visitBackendRoute } from "./secret-backend-browser.mjs";

const stopped =
  "The Tailscale browser node stopped. Check network access and reconnect.";

async function credentialReceipt(panel) {
  // The SDK can report Running while its vault credential write is pending.
  // The public header confirms its credential receipt after that write settles.
  await panel
    .page()
    .locator("header.conn-settings__head")
    .getByRole("img", { name: "Browser node connected", exact: true })
    .waitFor({ timeout: 45_000 });
}
async function connect(panel) {
  await panel
    .getByRole("button", { name: "Connect browser node", exact: true })
    .click();
  await panel
    .getByRole("img", { name: /^Connected: / })
    .waitFor({ timeout: 90_000 });
  await credentialReceipt(panel);
}
async function disconnect(panel) {
  const button = panel.getByRole("button", {
    name: "Disconnect browser node",
    exact: true,
  });
  if (await button.count()) await button.click();
  await expect(panel.getByRole("img", { name: /^Connected: / })).toHaveCount(0);
}
async function trust(panel, caPEM) {
  await panel
    .getByLabel("Tailnet service TLS trust", { exact: true })
    .selectOption("operator");
  await panel
    .getByLabel("Tailnet service CA certificates (PEM)", { exact: true })
    .fill(caPEM);
  await expect(
    panel.getByLabel("Integration HTTP transport", { exact: true }),
  ).toHaveValue("browser");
  await expect(
    panel.getByLabel("Integration origins and destination CIDRs", {
      exact: true,
    }),
  ).toHaveCount(0);
}
function counts(proof) {
  return { ...proof.stats, requests: proof.requests.length };
}
async function positive(panel, https, check, record, label) {
  const before = counts(https.trusted);
  try {
    await panel
      .getByLabel("Tailnet service URL", { exact: true })
      .fill(https.url);
    await credentialReceipt(panel);
    await panel
      .getByRole("button", { name: "Test tailnet service", exact: true })
      .click();
    const text = JSON.stringify({
      source: "real-native-tailscale-peer",
      nonce: https.trusted.nonce,
      path: "/proof",
    });
    await panel
      .getByRole("img", {
        name: `HTTP 200 · ${text.length} characters received through Tailscale`,
        exact: true,
      })
      .waitFor({ timeout: 45_000 });
    const after = counts(https.trusted);
    const received = https.trusted.requests.at(-1);
    check(
      after.requests === before.requests + 1 &&
        after.secure > before.secure &&
        received?.method === "GET" &&
        received.path === "/proof",
      `${label}: explicit peer CA permits a real native HTTPS GET with exact proof length`,
    );
    record("peer-tls-proof", JSON.stringify({ label, before, after }));
  } catch (error) {
    await failProof(panel, https.trusted, record, label, before, error);
  }
}
async function negative(panel, url, proof, check, record, label) {
  const before = counts(proof);
  try {
    await panel.getByLabel("Tailnet service URL", { exact: true }).fill(url);
    await credentialReceipt(panel);
    await panel
      .getByRole("button", { name: "Test tailnet service", exact: true })
      .click();
    await panel
      .getByRole("img", { name: stopped, exact: true })
      .waitFor({ timeout: 45_000 });
    await expect
      .poll(() => proof.stats.errors, { timeout: 45_000 })
      .toBeGreaterThan(before.errors);
    await expect(panel.getByRole("img", { name: /^HTTP 200 · / })).toHaveCount(
      0,
    );
    await expect(
      panel.getByRole("button", { name: "Connect browser node", exact: true }),
    ).toBeEnabled();
    const after = counts(proof);
    check(
      after.connections > before.connections &&
        after.errors > before.errors &&
        after.requests === before.requests,
      `${label}: actual TLS rejection receives zero HTTP and withdraws the original node`,
    );
    record("peer-tls-proof", JSON.stringify({ label, before, after }));
  } catch (error) {
    await failProof(panel, proof, record, label, before, error);
  }
}

async function failProof(panel, proof, record, label, before, error) {
  record(
    "peer-tls-failure",
    JSON.stringify({
      label,
      before,
      after: counts(proof),
      status: await panel
        .getByRole("img")
        .evaluateAll((nodes) =>
          nodes.map((node) => node.getAttribute("aria-label")),
        ),
    }),
  );
  const reason = error instanceof Error ? error.message : String(error);
  throw new Error(`${label}: ${reason}`, { cause: error });
}

export async function exerciseTailscalePeerHTTPS({
  page,
  base,
  fixture,
  hostname,
  width,
  check,
  record,
}) {
  const https = fixture.peerTLS;
  if (!https) throw new Error("Real peer TLS fixture was not enabled");
  const direct = [];
  const peerOrigins = new Set([
    new URL(https.url).origin,
    new URL(https.wrongHostnameUrl).origin,
  ]);
  const observe = (request) => {
    if (peerOrigins.has(new URL(request.url()).origin))
      direct.push(request.url());
  };
  page.context().on("request", observe);
  try {
    await visitBackendRoute(page, base, "settings/connections/tailscale");
    const panel = page.getByRole("region", {
      name: "Tailscale browser node",
      exact: true,
    });
    await panel
      .getByLabel("Browser node hostname", { exact: true })
      .fill(hostname);
    await panel
      .getByLabel("Tailscale control server", { exact: true })
      .fill(fixture.controlUrl);
    const summary = panel.getByText("Join with an existing auth key", {
      exact: true,
    });
    if ((await summary.locator("..").getAttribute("open")) === null)
      await summary.click();
    const secret = panel.getByLabel("Optional node auth key", { exact: true });
    await secret.fill(fixture.authKey);
    await trust(panel, https.caPEM);
    await connect(panel);
    await expect(secret).toHaveValue("");
    await positive(panel, https, check, record, `${width}-operator-ca`);
    await disconnect(panel);
    await trust(panel, https.wrongCAPEM);
    await connect(panel);
    await negative(
      panel,
      https.url,
      https.trusted,
      check,
      record,
      `${width}-wrong-ca`,
    );
    await trust(panel, https.caPEM);
    await connect(panel);
    await negative(
      panel,
      https.wrongHostnameUrl,
      https.wrongHostname,
      check,
      record,
      `${width}-correct-ca-wrong-hostname`,
    );
    await connect(panel);
    await positive(panel, https, check, record, `${width}-explicit-recovery`);
    await expect(
      panel.getByLabel("Integration HTTP transport", { exact: true }),
    ).toHaveValue("browser");
    check(
      direct.length === 0,
      `${width}: no browser fetch fallback contacted either HTTPS peer`,
    );
    await disconnect(panel);
    await panel
      .getByRole("button", { name: "Forget local browser node", exact: true })
      .click();
    await panel
      .getByRole("button", {
        name: "Confirm forget local browser node",
        exact: true,
      })
      .click();
  } finally {
    page.context().off("request", observe);
  }
}
