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
import * as agentAuthentication from "../../lib/local-agent-auth.js";
import { readLocalAgentKeys } from "../../lib/local-agent-keys.js";
import { changeLocalDirectory } from "../../lib/local-directory.js";
import { currentLocalIdentitySession } from "../../lib/local-sessions.js";
import { mintVaultKey } from "../../lib/vault/crypto.js";
import { lockAllTombs, unlockTomb } from "../../lib/vfs.js";
import { LocalAgentKeys } from "./LocalAgentKeys.js";

let tomb: string;
let principalId: string;
beforeEach(async () => {
  // jsdom's realm differs from Node's TextEncoder/WebCrypto realm.
  vi.stubGlobal("Uint8Array", new TextEncoder().encode("").constructor);
  tomb = `agent-ui-${crypto.randomUUID()}`;
  unlockTomb(tomb, (await mintVaultKey()).vaultKey);
  let queue = Promise.resolve();
  vi.stubGlobal("navigator", {
    locks: {
      request: <T,>(_name: string, run: () => Promise<T>) => {
        const next = queue.then(run);
        queue = next.then(
          () => undefined,
          () => undefined,
        );
        return next;
      },
    },
  });
  const directory = await changeLocalDirectory(tomb, 0, {
    action: "create",
    kind: "agent",
    name: "Test agent",
  });
  const agent = directory.entries[0];
  if (!agent) throw new Error("Missing agent fixture");
  principalId = agent.id;
});
afterEach(() => {
  cleanup();
  lockAllTombs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

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
      <button type="button">Another control</button>
    </>,
  );
  await userEvent.click(screen.getByText("Agent keys", { exact: true }));
  await screen.findByText("No agent keys enrolled.");
  await userEvent.click(
    screen.getByRole("button", { name: "Enroll public key" }),
  );
  const input = screen.getByLabelText("Public key JWK");
  expect(document.activeElement).toBe(input);
  fireEvent.change(input, { target: { value: JSON.stringify(key.publicKey) } });
  await userEvent.click(
    screen.getByRole("button", { name: "Save public key" }),
  );
  await screen.findByText("Agent key enrolled.");
  expect(await readLocalAgentKeys(tomb)).toHaveLength(1);
  await waitFor(() =>
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Enroll public key" }),
    ),
  );
  return key;
}

it("enrolls, authenticates with a real signature, and revokes the agent session", async () => {
  const key = await enroll();
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
  await screen.findByText(
    "Signed in locally with an agent key. No human approval or application access was granted.",
  );
  expect(
    (await currentLocalIdentitySession(tomb, principalId))?.authentication,
  ).toBe("agent_key");
  await userEvent.click(
    screen.getByRole("button", { name: "Revoke agent key" }),
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Confirm key revocation" }),
  );
  await screen.findByText("Agent key revoked.");
  await waitFor(async () =>
    expect(await currentLocalIdentitySession(tomb, principalId)).toBeNull(),
  );
  expect(await readLocalAgentKeys(tomb)).toHaveLength(0);
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
