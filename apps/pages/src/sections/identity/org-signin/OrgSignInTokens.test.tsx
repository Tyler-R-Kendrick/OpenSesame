/** @vitest-environment jsdom */
/**
 * SCIM provisioning tokens in Identity › Organizations (ADR 0140 plan step
 * 12): a minted token's plaintext is on the page once, copied through the
 * vault's clearing clipboard, and gone when hidden, when a token is revoked,
 * when the vault locks and when the panel unmounts — and it is never written
 * to storage or the address bar.
 */
import { deviceIdentitySeams } from "@opensesame/app-core/lib/device-identity.js";
import { identitySeams } from "@opensesame/app-core/lib/identity.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { registerTutorialRealm } from "@opensesame/app-core/tutorial/registry/optional-tutorials.test-support.js";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { vaultHooksSeams } from "../../../lib/vault/hooks.js";
import { OrgSignInPanels } from "./OrgSignInPanels.js";
import { orgSignInServer } from "./org-signin-server.test-support.js";

const originalIdentity = { ...identitySeams };
const originalDevice = { ...deviceIdentitySeams };
const originalHooks = { ...vaultHooksSeams };
const copySecret = vi.fn(async (_value: string) => "copied" as const);

let server = orgSignInServer();

function tokens() {
  return within(screen.getByRole("region", { name: "Provisioning tokens" }));
}

async function owner() {
  const view = render(<OrgSignInPanels online known={null} />);
  await screen.findByRole("region", { name: "Provisioning tokens" });
  return view;
}

async function mint() {
  const user = userEvent.setup();
  await user.click(
    tokens().getByRole("button", { name: "Mint a provisioning token" }),
  );
  await tokens().findByDisplayValue("sct_plaintext_1");
  return user;
}

/** Every value this origin can read back later, as one string. */
function everythingStored(): string {
  const read = (store: Storage) =>
    Array.from({ length: store.length }, (_, i) => {
      const key = store.key(i) ?? "";
      return `${key}=${store.getItem(key) ?? ""}`;
    }).join("\n");
  return [read(localStorage), read(sessionStorage), document.cookie].join("\n");
}

// The upstream panel is a guide target `enterprise.directory-provisioning`
// declares on activation.
let revokeRealm = () => {};
beforeAll(() => {
  revokeRealm = registerTutorialRealm();
});
afterAll(() => revokeRealm());

beforeEach(() => {
  deviceIdentitySeams.remoteIdentityApi = () => "https://id.example";
  identitySeams.currentSession = () => ({
    principalId: "prn_1",
    accessToken: "at",
    issuerOrigin: "https://id.example",
  });
  identitySeams.identityBase = () => "https://id.example";
  server = orgSignInServer({
    tokens: [
      { id: "sct_old", createdAt: "2026-08-25T00:00:00.000Z", revokedAt: null },
    ],
  });
  identitySeams.identityFetch = server.fetch;
  vaultHooksSeams.useCopySecret = () => copySecret;
  copySecret.mockClear();
});

afterEach(() => {
  cleanup();
  Object.assign(identitySeams, originalIdentity);
  Object.assign(deviceIdentitySeams, originalDevice);
  Object.assign(vaultHooksSeams, originalHooks);
});

describe("a minted provisioning token", () => {
  it("is shown once, with its SCIM address, and gone when hidden", async () => {
    await owner();
    const user = await mint();
    expect(
      tokens().getByRole("img", { name: "Shown once: copy it now" }),
    ).toBeTruthy();
    expect(
      tokens().getByDisplayValue(
        "https://id.example/v1/organizations/org_1/scim/v2",
      ),
    ).toBeTruthy();
    // The list gains the id and the date, never the value.
    expect(tokens().getByText("sct_id_1")).toBeTruthy();

    await user.click(tokens().getByRole("button", { name: "Copy the token" }));
    expect(copySecret).toHaveBeenCalledWith("sct_plaintext_1");

    await user.click(tokens().getByRole("button", { name: "Hide the token" }));
    expect(screen.queryByDisplayValue("sct_plaintext_1")).toBeNull();
    expect(document.body.innerHTML).not.toContain("sct_plaintext_1");
  });

  it("is never written to storage, a cookie or the address", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    await owner();
    await mint();
    expect(everythingStored()).not.toContain("sct_plaintext_1");
    expect(
      setItem.mock.calls.some((call) => call.join(" ").includes("sct_")),
    ).toBe(false);
    expect(window.location.href).not.toContain("sct_");
    expect(window.history.state ?? "").not.toContain("sct_");
    setItem.mockRestore();
  });

  it("does not come back when the panel is drawn again", async () => {
    const first = await owner();
    await mint();
    first.unmount();
    await owner();
    expect(await tokens().findByText("sct_id_1")).toBeTruthy();
    expect(screen.queryByDisplayValue("sct_plaintext_1")).toBeNull();
  });

  it("is dropped when the vault locks", async () => {
    await owner();
    await mint();
    act(() => vaultStore.lock());
    expect(screen.queryByDisplayValue("sct_plaintext_1")).toBeNull();
    expect(document.body.innerHTML).not.toContain("sct_plaintext_1");
  });

  it("is dropped when a token is revoked", async () => {
    await owner();
    const user = await mint();
    await user.click(tokens().getByRole("button", { name: "Revoke sct_old" }));
    await user.click(
      tokens().getByRole("button", { name: "Confirm revoking sct_old" }),
    );
    expect(
      await tokens().findByRole("img", { name: "Provisioning token revoked." }),
    ).toBeTruthy();
    expect(screen.queryByDisplayValue("sct_plaintext_1")).toBeNull();
  });
});

describe("revoking", () => {
  it("arms first, keeps on Keep, and marks the row revoked on confirm", async () => {
    await owner();
    const user = userEvent.setup();
    await user.click(
      await tokens().findByRole("button", { name: "Revoke sct_old" }),
    );
    expect(server.seen.some((call) => call.method === "DELETE")).toBe(false);
    await user.click(tokens().getByRole("button", { name: "Keep sct_old" }));
    await user.click(tokens().getByRole("button", { name: "Revoke sct_old" }));
    await user.click(
      tokens().getByRole("button", { name: "Confirm revoking sct_old" }),
    );
    await tokens().findByRole("img", { name: "Provisioning token revoked." });
    expect(tokens().getByRole("img", { name: "Revoked" })).toBeTruthy();
    expect(tokens().queryByRole("button", { name: /sct_old/ })).toBeNull();
    expect(server.seen.find((call) => call.method === "DELETE")?.path).toBe(
      "/v1/organizations/org_1/scim/tokens/sct_old",
    );
  });

  it("marks a refused mint on the panel and shows no token", async () => {
    identitySeams.identityFetch = async (path, init = {}) =>
      init.method === "POST"
        ? new Response(JSON.stringify({ error: "owner_required" }), {
            status: 403,
          })
        : server.fetch(path, init);
    await owner();
    const user = userEvent.setup();
    await user.click(
      tokens().getByRole("button", { name: "Mint a provisioning token" }),
    );
    expect(
      await tokens().findByRole("img", {
        name: "Only an owner of this organization can change these settings.",
      }),
    ).toBeTruthy();
    expect(screen.queryByLabelText(/^Token /)).toBeNull();
  });
});
