/** @vitest-environment jsdom */
import { LocalDirectoryError } from "@opensesame/app-core/lib/local-directory.js";
import { localRequestFixture } from "@opensesame/app-core/lib/local-request.fixture.js";
import * as sessions from "@opensesame/app-core/lib/local-sessions.js";
import * as authority from "@opensesame/app-core/lib/siop-authority.js";
import { lockAllTombs } from "@opensesame/app-core/lib/vfs.js";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import {
  type MockInstance,
  afterEach,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import * as social from "../../lib/siop-social.js";
import { vaultHooksSeams } from "../../lib/vault/hooks.js";
import { SiopAuthorize } from "../../screens/SiopAuthorize.js";

const originalVault = { ...vaultHooksSeams };
let fixture: Awaited<ReturnType<typeof localRequestFixture>>;
const navigate = vi.fn();
let approve: MockInstance<typeof authority.approveSiopAuthorizationWithSocial>;

beforeEach(async () => {
  vi.stubGlobal("Uint8Array", new TextEncoder().encode("").constructor);
  vi.stubGlobal("ArrayBuffer", new TextEncoder().encode("").buffer.constructor);
  fixture = await localRequestFixture();
  // A new social ceremony must authenticate its person; the request fixture's
  // earlier presentation is ended through the real session lifecycle first.
  await sessions.revokeLocalIdentitySession(fixture.tomb, fixture.session.id);
  vi.stubGlobal("location", Object.assign(location, { replace: navigate }));
  Object.assign(vaultHooksSeams, {
    useVault: () => ({ ...originalVault.useVault(), tomb: fixture.tomb }),
  });
  vi.spyOn(social, "useSiopSocialChoices").mockReturnValue([
    {
      id: "github",
      source: "connection",
      providerId: "github",
      label: "GitHub",
      connectionId: "conn_github",
    },
  ]);
  const realApprove = authority.approveSiopAuthorizationWithSocial;
  approve = vi
    .spyOn(authority, "approveSiopAuthorizationWithSocial")
    .mockImplementation((tomb, proof, request) =>
      realApprove(tomb, proof, request, {
        socialConnection: async () => ({
          providerId: "github",
          status: "active",
        }),
      }),
    );
});

afterEach(() => {
  cleanup();
  lockAllTombs();
  Object.assign(vaultHooksSeams, originalVault);
  navigate.mockClear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function chooseSocial() {
  const params = new URLSearchParams({
    response_type: "id_token",
    client_id: fixture.applicationId,
    redirect_uri: "https://rp.example.test/callback",
    scope: "openid",
    nonce: "social-consent-nonce",
    response_mode: "fragment",
  });
  render(
    <MemoryRouter initialEntries={[`/identity/siop?${params}`]}>
      <SiopAuthorize />
    </MemoryRouter>,
  );
  await userEvent.selectOptions(
    await screen.findByLabelText("Person"),
    "Test person",
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Continue with GitHub" }),
  );
  expect(
    screen.getByLabelText("Self-issued sign-in status").textContent,
  ).toContain("Signed in with GitHub");
  expect(
    screen.queryByRole("button", { name: "Allow Self-Issued sign-in" }),
  ).toBeNull();
  expect(approve).not.toHaveBeenCalled();
  expect(await sessions.currentLocalIdentityActor(fixture.tomb)).toBeNull();
}

it("authenticates the selected local person before approving the same social proof", async () => {
  await chooseSocial();
  await userEvent.click(
    screen.getByRole("button", { name: "Verify with passkey" }),
  );
  const allow = await screen.findByRole("button", {
    name: "Allow Self-Issued sign-in",
  });
  expect(
    (await sessions.currentLocalIdentityActor(fixture.tomb))?.principalId,
  ).toBe(fixture.personId);
  expect(
    screen.getByLabelText("Self-issued sign-in status").textContent,
  ).toContain("Signed in with GitHub. Passkey verified.");
  await userEvent.click(allow);
  await waitFor(() => expect(navigate).toHaveBeenCalledOnce());
  expect(approve).toHaveBeenCalledWith(
    fixture.tomb,
    expect.objectContaining({
      source: "connection",
      personId: fixture.personId,
      connectionId: "conn_github",
    }),
    expect.objectContaining({ clientId: fixture.applicationId }),
  );
  expect(navigate.mock.calls[0]?.[0]).toMatch(
    /^https:\/\/rp\.example\.test\/callback#id_token=/,
  );
});

it("keeps social evidence from authorizing after local passkey verification fails", async () => {
  await chooseSocial();
  vi.spyOn(sessions, "signInLocalIdentity").mockRejectedValueOnce(
    new LocalDirectoryError("Passkey verification refused"),
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Verify with passkey" }),
  );
  await waitFor(() =>
    expect(
      screen.queryByRole("button", { name: "Verify with passkey" }),
    ).toBeNull(),
  );
  expect(
    screen.queryByRole("button", { name: "Allow Self-Issued sign-in" }),
  ).toBeNull();
  expect(approve).not.toHaveBeenCalled();
  expect(navigate).not.toHaveBeenCalled();
});

it("discards social evidence when the selected local person changes", async () => {
  await chooseSocial();
  await userEvent.selectOptions(screen.getByLabelText("Person"), "");
  expect(screen.getByLabelText("Self-issued sign-in status").textContent).toBe(
    "Verify to continue.",
  );
  await userEvent.selectOptions(screen.getByLabelText("Person"), "Test person");
  expect(screen.getByLabelText("Self-issued sign-in status").textContent).toBe(
    "Verify to continue.",
  );
  expect(approve).not.toHaveBeenCalled();
  expect(navigate).not.toHaveBeenCalled();
});
