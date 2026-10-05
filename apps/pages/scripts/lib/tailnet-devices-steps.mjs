// The changes `verify-tailnet-devices.mjs` makes through the page, each
// checked twice: on screen, and in what the Tailscale stub received.
import { expect } from "@playwright/test";

function region(page) {
  return page.getByRole("region", { name: "Tailnet devices" });
}

function row(page, name) {
  return region(page)
    .getByRole("listitem")
    .filter({
      has: page.getByRole("heading", { level: 3, name, exact: true }),
    });
}

/** The calls Tailscale received for one method and path. */
function received(stub, method, path) {
  return stub.tailnet.calls.filter(
    (call) => call.method === method && call.path === path,
  );
}

async function expectReceived(until, stub, method, path, body) {
  await until(
    async () =>
      received(stub, method, path).some(
        (call) => body === undefined || JSON.stringify(call.body) === body,
      ),
    `${method} ${path} ${body ?? ""}`,
  );
}

// TD-APPROVE
export async function approve({ page, stub, shot, until }) {
  const phone = row(page, "sams-phone");
  await expect(
    phone.getByRole("img", { name: "Waiting for approval" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Approve sams-phone" }).click();
  await expectReceived(
    until,
    stub,
    "POST",
    "/api/v2/device/nSAMSPHONECNTRL/authorized",
    '{"authorized":true}',
  );
  await expect(
    phone.getByRole("img", { name: "Waiting for approval" }),
  ).toHaveCount(0, { timeout: 20_000 });
  console.log("TD-APPROVE ok");
  await shot(page, "1280-approved");
}

// TD-EDIT
export async function editPangolin({ page, stub, shot, until }) {
  await page.getByRole("button", { name: "Settings for pangolin" }).click();
  const sheet = page.getByRole("dialog", { name: "Settings for pangolin" });
  await sheet.getByLabel("Name", { exact: true }).fill("web-01");
  await sheet.getByLabel("Tags", { exact: true }).fill("tag:web tag:edge");
  await sheet.getByRole("switch", { name: "Exit node" }).click();
  await shot(page, "1280-settings");
  await sheet.getByRole("button", { name: "Save changes" }).click();
  await sheet.waitFor({ state: "detached", timeout: 20_000 });
  const device = "/api/v2/device/nPANGOLINCNTRL";
  await expectReceived(
    until,
    stub,
    "POST",
    `${device}/name`,
    '{"name":"web-01"}',
  );
  await expectReceived(
    until,
    stub,
    "POST",
    `${device}/tags`,
    '{"tags":["tag:edge","tag:web"]}',
  );
  // The subnet stays approved and the exit node's two routes join it.
  await until(
    async () =>
      received(stub, "POST", `${device}/routes`).some(
        (call) =>
          [...(call.body?.routes ?? [])].sort().join(" ") ===
          "0.0.0.0/0 10.0.0.0/16 ::/0",
      ),
    "the exit node approved",
  );
  await expect(row(page, "web-01")).toBeVisible({ timeout: 20_000 });

  // A tag the tailnet policy does not own: Tailscale's own words come back.
  await page.getByRole("button", { name: "Settings for web-01" }).click();
  const again = page.getByRole("dialog", { name: "Settings for web-01" });
  await again.getByLabel("Tags", { exact: true }).fill("tag:nobody");
  await again.getByRole("button", { name: "Save changes" }).click();
  await expect(
    again
      .getByRole("alert")
      .getByRole("img", { name: /tag:nobody is not a valid tag/ }),
  ).toBeVisible({ timeout: 20_000 });
  await shot(page, "1280-refused");
  await page.keyboard.press("Escape");
  await again.waitFor({ state: "detached" });
  console.log("TD-EDIT ok");
}

/** The key Tailscale was asked for: a week, reusable, pre-approved, tag:ci. */
function expectMintedAsChosen(stub) {
  const body = received(stub, "POST", "/api/v2/tailnet/example.com/keys").at(
    -1,
  )?.body;
  const create = body?.capabilities?.devices?.create;
  const asChosen =
    body?.expirySeconds === 604_800 &&
    create?.reusable === true &&
    create?.preauthorized === true &&
    JSON.stringify(create?.tags) === '["tag:ci"]';
  if (!asChosen) throw new Error(`TD-ADD: minted ${JSON.stringify(body)}`);
}

// TD-ADD
export async function mintAndJoin({ page, stub, shot, until }) {
  await page.getByRole("button", { name: "Add a device" }).click();
  const sheet = page.getByRole("dialog", { name: "Add a device" });
  await sheet.getByLabel("Description", { exact: true }).fill("lab runners");
  await sheet.getByRole("button", { name: "7 days" }).click();
  await sheet.getByRole("switch", { name: "Reusable" }).click();
  await sheet.getByLabel("Tags", { exact: true }).fill("tag:ci");
  await shot(page, "1280-add-device");
  await sheet.getByRole("button", { name: "Mint an auth key" }).click();
  const field = sheet.getByLabel("Auth key", { exact: true });
  await expect(field).toHaveValue(/^tskey-auth-/, { timeout: 20_000 });
  const secret = await field.inputValue();
  await expect(sheet.getByLabel("Join command", { exact: true })).toHaveValue(
    `tailscale up --auth-key=${secret}`,
  );
  expectMintedAsChosen(stub);
  await shot(page, "1280-key-minted");
  await sheet.getByRole("button", { name: "Done" }).click();
  await sheet.waitFor({ state: "detached" });
  if ((await page.content()).includes(secret))
    throw new Error("TD-ADD: the key stayed on the page after Done");

  // A machine runs `tailscale up --auth-key=…` with it.
  stub.join(secret, "ci-runner-7");
  await page.getByRole("button", { name: "Reload tailnet devices" }).click();
  const joined = row(page, "ci-runner-7");
  await expect(joined).toBeVisible({ timeout: 20_000 });
  await expect(joined).toContainText("tag:ci");
  await expect(
    joined.getByRole("img", { name: "Waiting for approval" }),
  ).toHaveCount(0);
  console.log("TD-ADD ok");
  await shot(page, "1280-joined");
  return secret;
}

// TD-EXPIRE
export async function removeAndRevoke({ page, stub, shot, until }) {
  await page.getByRole("button", { name: "Expire ci-runner-7's key" }).click();
  await page
    .getByRole("button", {
      name: "Confirm expiring ci-runner-7's key; it must sign in again",
    })
    .click();
  await expectReceived(
    until,
    stub,
    "POST",
    "/api/v2/device/nCIRUNNER7CNTRL/expire",
  );

  const keys = page.getByRole("region", { name: "Tailnet auth keys" });
  await keys
    .getByRole("button", { name: "Revoke the auth key lab runners" })
    .click();
  await keys
    .getByRole("button", { name: "Confirm revoking the auth key lab runners" })
    .click();
  await until(
    async () =>
      stub.tailnet.calls.some(
        (call) =>
          call.method === "DELETE" &&
          call.path.startsWith("/api/v2/tailnet/example.com/keys/"),
      ),
    "the key revoked",
  );
  await expect(keys.getByRole("heading", { name: "lab runners" })).toHaveCount(
    0,
    { timeout: 20_000 },
  );

  await page
    .getByRole("button", { name: "Remove ci-runner-7 from the tailnet" })
    .click();
  // One press arms; nothing has reached Tailscale yet.
  if (received(stub, "DELETE", "/api/v2/device/nCIRUNNER7CNTRL").length > 0)
    throw new Error("TD-EXPIRE: removed on the first press");
  await shot(page, "1280-remove-armed");
  await page
    .getByRole("button", {
      name: "Confirm removing ci-runner-7 from the tailnet",
    })
    .click();
  await expectReceived(until, stub, "DELETE", "/api/v2/device/nCIRUNNER7CNTRL");
  await expect(row(page, "ci-runner-7")).toHaveCount(0, { timeout: 20_000 });
  console.log("TD-EXPIRE ok");
}
