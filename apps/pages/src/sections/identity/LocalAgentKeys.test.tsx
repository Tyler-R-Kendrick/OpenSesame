import * as agentAuthentication from "@opensesame/app-core/lib/local-agent-auth.js";
import { readLocalAgentKeys } from "@opensesame/app-core/lib/local-agent-keys.js";
import { localRequestFixture } from "@opensesame/app-core/lib/local-request.fixture.js";
import {
  currentLocalIdentitySession,
  signInLocalIdentity,
} from "@opensesame/app-core/lib/local-sessions.js";
import { lockAllTombs } from "@opensesame/app-core/lib/vfs.js";
/** @vitest-environment jsdom */
import {
  type LocalAgentChallenge,
  createLocalAgentKey,
} from "@opensesame/static-auth";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LocalAgentKeys } from "./LocalAgentKeys.js";
import { LocalIdentitySession } from "./LocalIdentitySession.js";

let fixture: Awaited<ReturnType<typeof localRequestFixture>>;
let tomb: string;
let principalId: string;
/**
 * The vault's owner, signed in with a passkey. A directory change ends every
 * session, and a tab that has signed an agent in administers only as that
 * agent (97d68ee57), so the owner signs in again before administering.
 */
async function signOwnerIn() {
  fixture.session = await signInLocalIdentity(tomb, fixture.personId);
}
beforeEach(async () => {
  // jsdom's realm differs from Node's TextEncoder/WebCrypto realm.
  vi.stubGlobal("Uint8Array", new TextEncoder().encode("").constructor);
  vi.stubGlobal("ArrayBuffer", new TextEncoder().encode("").buffer.constructor);
  fixture = await localRequestFixture();
  tomb = fixture.tomb;
  const directory = await fixture.change({
    action: "create",
    kind: "agent",
    name: "Test agent",
  });
  const agent = directory.entries.find((row) => row.kind === "agent");
  if (!agent) throw new Error("Missing agent fixture");
  principalId = agent.id;
  await signOwnerIn();
});
afterEach(() => {
  cleanup();
  lockAllTombs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function revokeKey() {
  await userEvent.click(
    screen.getByRole("button", { name: "Revoke agent key" }),
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Confirm key revocation" }),
  );
}

async function enroll() {
  const key = await createLocalAgentKey();
  render(
    <>
      <LocalAgentKeys
        tomb={tomb}
        principalId={principalId}
        disabled={false}
        enabled
      />
      <LocalIdentitySession
        tomb={tomb}
        principalId={fixture.personId}
        disabled={false}
      />
      <button type="button">Another control</button>
    </>,
  );
  await userEvent.click(screen.getByText("Agent keys", { exact: true }));
  await screen.findByRole("img", { name: "No agent keys enrolled." });
  await userEvent.click(
    screen.getByRole("button", { name: "Enroll public key" }),
  );
  const input = screen.getByLabelText("Public key JWK");
  expect(document.activeElement).toBe(input);
  fireEvent.change(input, { target: { value: JSON.stringify(key.publicKey) } });
  await userEvent.click(
    screen.getByRole("button", { name: "Save public key" }),
  );
  await waitFor(() =>
    expect(
      screen.getByRole("status", { name: "Agent key status" }).textContent,
    ).toBe("Agent key enrolled."),
  );
  expect(await readLocalAgentKeys(tomb)).toHaveLength(1);
  await waitFor(() =>
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Enroll public key" }),
    ),
  );
  return key;
}

it("refuses the agent's own revoke, then revokes once the tab returns to the owner", async () => {
  const key = await enroll();
  const [enrolled] = await readLocalAgentKeys(tomb);
  if (!enrolled) throw new Error("Missing enrolled key");
  // The owner who enrolled the key steps away, and the agent signs in here.
  await userEvent.click(
    screen.getByRole("button", { name: "Sign out locally" }),
  );
  await waitFor(async () =>
    expect(
      await currentLocalIdentitySession(tomb, fixture.personId),
    ).toBeNull(),
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Authenticate agent" }),
  );
  const input = await screen.findByLabelText("Agent challenge");
  if (!(input instanceof HTMLTextAreaElement))
    throw new Error("Missing challenge field");
  const challenge: LocalAgentChallenge = JSON.parse(input.value);
  const proof = await key.signChallenge(
    challenge,
    location.origin,
    principalId,
  );
  fireEvent.change(screen.getByLabelText("Signed challenge"), {
    target: { value: proof },
  });
  await userEvent.click(screen.getByRole("button", { name: "Verify agent" }));
  await waitFor(() =>
    expect(
      screen.getByRole("status", { name: "Agent session status" }).textContent,
    ).toBe(
      "Signed in locally with an agent key. No human approval or application access was granted.",
    ),
  );
  expect(
    (await currentLocalIdentitySession(tomb, principalId))?.authentication,
  ).toBe("agent_key");

  // The agent is now this tab's actor and may not revoke a key: with no
  // custodian fallback (97d68ee57) the refusal is a mark on the key status,
  // never a box in the page, and the key stays.
  await revokeKey();
  const refusal = await screen.findByRole("img", {
    name: /^Only an operator can change Access or Identity administration/,
  });
  expect(refusal.className).toContain("status-mark--err");
  for (const alert of screen.queryAllByRole("alert"))
    expect(alert.className).toContain("visually-hidden");
  expect(await readLocalAgentKeys(tomb)).toHaveLength(1);

  // The tab returns to the owner as a person would: the agent signs out, and
  // the owner signs in with their passkey from their own session controls.
  await userEvent.click(screen.getByRole("button", { name: "Sign out agent" }));
  await waitFor(async () =>
    expect(await currentLocalIdentitySession(tomb, principalId)).toBeNull(),
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Sign in locally" }),
  );
  await waitFor(() =>
    expect(
      screen.getByRole("status", { name: "Local session status" }).textContent,
    ).toBe(
      "Signed in locally with a passkey. No application access was granted.",
    ),
  );

  // The refused revoke left the key armed; the owner confirms it.
  await userEvent.click(
    screen.getByRole("button", { name: "Confirm key revocation" }),
  );
  await waitFor(() =>
    expect(
      screen.getByRole("status", { name: "Agent key status" }).textContent,
    ).toBe("Agent key revoked."),
  );
  expect(await readLocalAgentKeys(tomb)).toHaveLength(0);
  // The agent can no longer authenticate: nothing is offered to prove with,
  // and a challenge for the revoked credential is refused.
  expect(
    screen.queryByRole("button", { name: "Authenticate agent" }),
  ).toBeNull();
  await expect(
    agentAuthentication.beginLocalAgentAuthentication(
      tomb,
      principalId,
      enrolled.credentialId,
    ),
  ).rejects.toThrow();
  expect(await currentLocalIdentitySession(tomb, principalId)).toBeNull();
  await waitFor(() =>
    expect(document.activeElement).toBe(
      screen.getByText("Agent keys", { exact: true }),
    ),
  );
});

it("does not steal focus when the user leaves a pending challenge", async () => {
  await enroll();
  const begin = agentAuthentication.beginLocalAgentAuthentication;
  let release: (() => void) | undefined;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.spyOn(
    agentAuthentication,
    "beginLocalAgentAuthentication",
  ).mockImplementationOnce(async (...args) => {
    const challenge = await begin(...args);
    await pending;
    return challenge;
  });
  await userEvent.click(
    screen.getByRole("button", { name: "Authenticate agent" }),
  );
  await screen.findByText("Preparing agent challenge…");
  const other = screen.getByRole("button", { name: "Another control" });
  await userEvent.click(other);
  if (!release) throw new Error("Missing pending challenge release");
  const finish = release;
  await act(async () => finish());
  await screen.findByLabelText("Agent challenge");
  expect(document.activeElement).toBe(other);
});

it("never reports an invalid signature as an authenticated session", async () => {
  await enroll();
  await userEvent.click(
    screen.getByRole("button", { name: "Authenticate agent" }),
  );
  await screen.findByLabelText("Agent challenge");
  fireEvent.change(screen.getByLabelText("Signed challenge"), {
    target: { value: "fake.signed.proof" },
  });
  await userEvent.click(screen.getByRole("button", { name: "Verify agent" }));
  await screen.findByRole("alert");
  expect(await currentLocalIdentitySession(tomb, principalId)).toBeNull();
  expect(screen.queryByLabelText("Signed challenge")).toBeNull();
});
