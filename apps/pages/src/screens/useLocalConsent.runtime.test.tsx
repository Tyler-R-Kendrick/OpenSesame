// @vitest-environment jsdom
import { listReceipts } from "@opensesame/app-core/lib/device-receipts.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import type { LocalAuthorizationRequest } from "@opensesame/static-auth";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  type ConsentOwner,
  consentOwner,
} from "./local-consent-owner.test-support.js";
import { useLocalConsent } from "./useLocalConsent.js";

let fixture: ConsentOwner;
beforeEach(async () => {
  fixture = await consentOwner();
});
afterEach(async () => {
  await fixture.release();
});
function Consent({
  request = fixture.request,
}: { request?: LocalAuthorizationRequest }) {
  const consent = useLocalConsent(fixture.tomb, request);
  return (
    <section>
      <h1>{consent.application}</h1>
      <output aria-label="Channel status">{consent.status}</output>
      <output aria-label="Consent error">{consent.error}</output>
      <select
        aria-label="Person"
        value={consent.person}
        onChange={(e) => consent.setPerson(e.target.value)}
      >
        <option value="">Choose</option>
        {consent.people.map((person) => (
          <option key={person.id} value={person.id}>
            {person.name}
          </option>
        ))}
      </select>
      <button type="button" onClick={() => void consent.run(false)}>
        Verify
      </button>
      <button type="button" onClick={() => void consent.run(true)}>
        Allow
      </button>
      <button type="button" onClick={() => void consent.deny()}>
        Deny
      </button>
      <output aria-label="Verified identity">
        {consent.session?.principalId ?? ""}
      </output>
    </section>
  );
}
it("loads only enabled organization members and verifies a genuine passkey before approval", async () => {
  render(<Consent />);
  await screen.findByRole("heading", { name: "Registered relying party" });
  expect(screen.getByRole("option", { name: "Consent member" })).toBeTruthy();
  expect(
    screen.queryByRole("option", { name: "Unassigned outsider" }),
  ).toBeNull();
  await act(async () => {
    fixture.connect();
  });
  await waitFor(() =>
    expect(screen.getByLabelText("Channel status").textContent).toBe(
      "connected",
    ),
  );
  fireEvent.change(screen.getByLabelText("Person"), {
    target: { value: fixture.person },
  });
  fireEvent.click(screen.getByRole("button", { name: "Allow" }));
  expect(screen.getByLabelText("Verified identity").textContent).toBe("");
  fireEvent.click(screen.getByRole("button", { name: "Verify" }));
  await waitFor(() =>
    expect(screen.getByLabelText("Verified identity").textContent).toBe(
      fixture.person,
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "Allow" }));
  await waitFor(() =>
    expect(screen.getByLabelText("Channel status").textContent).toBe(
      "approved",
    ),
  );
});
it("refuses an unregistered callback without exposing eligible identities", async () => {
  render(
    <Consent
      request={{
        ...fixture.request,
        redirectUri: "https://attacker.example.test/callback",
      }}
    />,
  );
  await waitFor(() =>
    expect(screen.getByLabelText("Consent error").textContent).toContain(
      "unavailable",
    ),
  );
  expect(screen.queryByRole("option", { name: "Consent owner" })).toBeNull();
  expect(screen.getByLabelText("Channel status").textContent).toBe("closed");
});
it("rejects a genuinely bad passkey signature and closes the issuer on the real owner lock", async () => {
  render(<Consent />);
  await screen.findByRole("heading", { name: "Registered relying party" });
  await act(async () => {
    fixture.connect();
  });
  fixture.device.control.badSignature = true;
  fireEvent.change(screen.getByLabelText("Person"), {
    target: { value: fixture.person },
  });
  fireEvent.click(screen.getByRole("button", { name: "Verify" }));
  await waitFor(() =>
    expect(screen.getByLabelText("Consent error").textContent).not.toBe(""),
  );
  expect(screen.getByLabelText("Verified identity").textContent).toBe("");
  await act(async () => {
    vaultStore.lock();
  });
  expect(screen.getByLabelText("Channel status").textContent).toBe("closed");
});
it("records explicit denial once in the actual encrypted receipt ledger", async () => {
  render(<Consent />);
  await screen.findByRole("heading", { name: "Registered relying party" });
  fireEvent.click(screen.getByRole("button", { name: "Deny" }));
  fireEvent.click(screen.getByRole("button", { name: "Deny" }));
  await waitFor(() =>
    expect(screen.getByLabelText("Channel status").textContent).toBe("closed"),
  );
  const receipts = await listReceipts(fixture.tomb, 20);
  expect(
    receipts.filter((receipt) => receipt.eventType === "access.sign_in.denied"),
  ).toHaveLength(1);
});
