// @vitest-environment jsdom
import {
  readLocalAgentKeys,
  registerLocalAgentKey,
} from "@opensesame/app-core/lib/local-agent-keys.js";
import { serializeAuthorizationRequest } from "@opensesame/siop-v2";
import {
  createLocalAgentKey,
  localAuthorizationQuery,
} from "@opensesame/static-auth";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, it } from "vitest";
import { LocalAuthorize } from "./LocalAuthorize.js";
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

it("shows local subject, resource policy and secret boundaries before allowing a registered application", async () => {
  render(
    <MemoryRouter
      initialEntries={[
        `/identity/local?${localAuthorizationQuery(fixture.request)}`,
      ]}
    >
      <LocalAuthorize />
    </MemoryRouter>,
  );
  await screen.findByRole("heading", {
    name: "Sign in to Registered relying party",
  });
  const facts = within(screen.getByLabelText("Authorization boundaries"));
  expect(facts.getByText("Your local subject identifier.")).toBeTruthy();
  expect(
    facts.getByText("Requires the application's own policy."),
  ).toBeTruthy();
  expect(facts.getByText("No vault contents or upstream token.")).toBeTruthy();
  expect(facts.queryByText("Lifetime")).toBeNull();
  expect(
    screen.getByRole("button", { name: "Verify with passkey" }),
  ).toBeTruthy();
  expect(fixture.location.replace).not.toHaveBeenCalled();
});

it("shows named-agent authority and either-session revocation limits for a genuinely enrolled agent", async () => {
  const agent = await fixture.create("agent", "Bounded consent agent");
  const key = await createLocalAgentKey();
  await registerLocalAgentKey(fixture.tomb, agent, key.publicKey);
  const record = (await readLocalAgentKeys(fixture.tomb)).find(
    (entry) => entry.principalId === agent,
  );
  if (!record) throw new Error("Missing actual enrolled agent key");
  const request = {
    ...fixture.request,
    agent: { principalId: agent, keyId: record.keyId },
  };
  render(
    <MemoryRouter
      initialEntries={[`/identity/local?${localAuthorizationQuery(request)}`]}
    >
      <LocalAuthorize />
    </MemoryRouter>,
  );
  await screen.findByRole("heading", {
    name: "Authorize agent access to Registered relying party",
  });
  const facts = within(screen.getByLabelText("Authorization boundaries"));
  expect(facts.getByText("Named agent, not your identity.")).toBeTruthy();
  expect(
    facts.getByText("Ends when either session expires or is revoked."),
  ).toBeTruthy();
  expect(facts.getByText("No vault contents or upstream token.")).toBeTruthy();
  expect(facts.queryByText("Your local subject identifier.")).toBeNull();
  expect(fixture.location.replace).not.toHaveBeenCalled();
});

it("shows the self-issued signing, verification, no-secret and draft facts before passkey consent", async () => {
  const query = serializeAuthorizationRequest({
    clientId: fixture.application,
    redirectUri: fixture.redirect,
    nonce: "siop-disclosure-unique-nonce",
    scope: "openid",
    responseType: "id_token",
    responseMode: "fragment",
    state: "siop-disclosure-state",
  });
  render(
    <MemoryRouter initialEntries={[`/identity/siop?${query}`]}>
      <SiopAuthorize />
    </MemoryRouter>,
  );
  await screen.findByRole("heading", {
    name: "Self-issued sign-in to Registered relying party",
  });
  const facts = within(
    screen.getByLabelText("Self-issued authorization boundaries"),
  );
  expect(
    facts.getByText("Self-Issued ID Token signed in your vault."),
  ).toBeTruthy();
  expect(
    facts.getByText(
      "The relying party verifies your public key from the response.",
    ),
  ).toBeTruthy();
  expect(facts.getByText("No vault contents or upstream token.")).toBeTruthy();
  expect(
    facts.getByText("SIOPv2 is an OpenID Implementer's Draft."),
  ).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "Verify with passkey" }),
  ).toBeTruthy();
  expect(fixture.location.replace).not.toHaveBeenCalled();
});
