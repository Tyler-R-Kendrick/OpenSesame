// @vitest-environment jsdom
import { listReceipts } from "@opensesame/app-core/lib/device-receipts.js";
import { siopIssuerProfile } from "@opensesame/app-core/lib/siop-authority.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import {
  parseFragmentResponse,
  serializeAuthorizationRequest,
  verifySelfIssuedIdToken,
} from "@opensesame/siop-v2";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { expectInTray } from "../components/tray.test-support.js";
import { SiopAuthorize } from "./SiopAuthorize.js";
import {
  type ConsentOwner,
  consentOwner,
} from "./local-consent-owner.test-support.js";

let fixture: ConsentOwner;
beforeEach(async () => {
  fixture = await consentOwner();
});
afterEach(async () => {
  await fixture.release();
});
function search(redirectUri = fixture.redirect) {
  return serializeAuthorizationRequest({
    clientId: fixture.application,
    redirectUri,
    nonce: "siop-runtime-unique-nonce",
    scope: "openid",
    responseType: "id_token",
    responseMode: "fragment",
    state: "siop-runtime-state",
  });
}
function open(query = search()) {
  render(
    <MemoryRouter initialEntries={[`/identity/siop?${query}`]}>
      <SiopAuthorize />
    </MemoryRouter>,
  );
}
async function selectOwner() {
  await screen.findByRole("heading", {
    name: "Self-issued sign-in to Registered relying party",
  });
  fireEvent.change(screen.getByLabelText("Person"), {
    target: { value: fixture.person },
  });
}
it("renders invalid requests without any verification or approval operation", async () => {
  open("client_id=missing");
  expect(
    screen.getByRole("heading", { name: "Invalid Self-Issued request" }),
  ).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: "Verify with passkey" }),
  ).toBeNull();
  expect(fixture.location.replace).not.toHaveBeenCalled();
});
it("rejects a callback outside the actual encrypted application registration", async () => {
  open(search("https://attacker.example.test/callback"));
  await expectInTray(/Self-Issued request is unavailable/);
  expect(screen.queryByLabelText("Person")).toBeNull();
  expect(fixture.location.replace).not.toHaveBeenCalled();
});
it("verifies a real passkey and returns a cryptographically verified SIOP token for the registered RP", async () => {
  open();
  await selectOwner();
  expect(
    screen.queryByRole("option", { name: "Unassigned outsider" }),
  ).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Verify with passkey" }));
  await screen.findByRole("button", { name: "Allow Self-Issued sign-in" });
  expect(fixture.location.replace).not.toHaveBeenCalled();
  fireEvent.click(
    screen.getByRole("button", { name: "Allow Self-Issued sign-in" }),
  );
  await waitFor(() =>
    expect(fixture.location.replace).toHaveBeenCalledTimes(1),
  );
  const callback = fixture.location.replace.mock.calls[0]?.[0];
  if (!callback) throw new Error("Missing actual SIOP callback");
  const parsed = parseFragmentResponse(String(callback));
  if (parsed.kind !== "success")
    throw new Error("Expected signed SIOP response");
  expect(parsed.state).toBe("siop-runtime-state");
  const verified = await verifySelfIssuedIdToken({
    idToken: parsed.idToken,
    expectedAudience: fixture.application,
    expectedNonce: "siop-runtime-unique-nonce",
    profile: siopIssuerProfile(),
    nowSeconds: Math.floor(Date.now() / 1000),
  });
  expect(verified.aud).toBe(fixture.application);
  expect(String(callback)).not.toContain("privateJwk");
});
it("records one explicit refusal and redirects only an OAuth denial, never an ID token", async () => {
  open();
  await selectOwner();
  const deny = screen.getByRole("button", { name: "Deny" });
  fireEvent.click(deny);
  fireEvent.click(deny);
  await waitFor(() =>
    expect(fixture.location.replace).toHaveBeenCalledTimes(1),
  );
  const callback = fixture.location.replace.mock.calls[0]?.[0];
  if (!callback) throw new Error("Missing actual denial callback");
  expect(parseFragmentResponse(String(callback))).toMatchObject({
    kind: "error",
    error: "access_denied",
    state: "siop-runtime-state",
  });
  const receipts = await listReceipts(fixture.tomb, 20);
  expect(
    receipts.filter((receipt) => receipt.eventType === "access.siop.denied"),
  ).toHaveLength(1);
});
it("does not approve a genuinely invalid authenticator signature", async () => {
  open();
  await selectOwner();
  fixture.device.control.badSignature = true;
  fireEvent.click(screen.getByRole("button", { name: "Verify with passkey" }));
  await expectInTray("The identity proof was refused.");
  expect(
    screen.queryByRole("button", { name: "Allow Self-Issued sign-in" }),
  ).toBeNull();
  expect(fixture.location.replace).not.toHaveBeenCalled();
});
it("refuses registration access after an actual vault lock", async () => {
  vaultStore.lock();
  open();
  await expectInTray(/Self-Issued request is unavailable/);
  expect(screen.queryByLabelText("Person")).toBeNull();
  expect(fixture.location.replace).not.toHaveBeenCalled();
});

it("refuses a held genuine passkey proof after lock and same-vault fresh owner recovery", async () => {
  const get = fixture.device.get.bind(fixture.device);
  let entered = false;
  let finish: () => void = () => {
    throw new Error("Missing passkey wait resolver");
  };
  const held = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const pending = vi
    .spyOn(fixture.device, "get")
    .mockImplementationOnce(async (options) => {
      const credential = await get(options);
      entered = true;
      await held;
      return credential;
    });
  open();
  await selectOwner();
  fireEvent.click(screen.getByRole("button", { name: "Verify with passkey" }));
  try {
    await waitFor(() => expect(entered).toBe(true));
    expect(
      screen
        .getByRole("region", { name: "Self-issued sign-in" })
        .getAttribute("aria-busy"),
    ).toBe("true");
    await act(async () => {
      vaultStore.lock();
      await vaultStore.unlock(fixture.password);
    });
  } finally {
    finish();
  }
  await waitFor(() =>
    expect(
      screen
        .getByRole("region", { name: "Self-issued sign-in" })
        .getAttribute("aria-busy"),
    ).toBe("false"),
  );
  expect(
    screen.queryByRole("button", { name: "Allow Self-Issued sign-in" }),
  ).toBeNull();
  expect(fixture.location.replace).not.toHaveBeenCalled();
  pending.mockRestore();
  const { cleanup } = await import("@testing-library/react");
  cleanup();
  open();
  await selectOwner();
  fireEvent.click(screen.getByRole("button", { name: "Verify with passkey" }));
  await screen.findByRole("button", { name: "Allow Self-Issued sign-in" });
  fireEvent.click(
    screen.getByRole("button", { name: "Allow Self-Issued sign-in" }),
  );
  await waitFor(() =>
    expect(fixture.location.replace).toHaveBeenCalledTimes(1),
  );
});
