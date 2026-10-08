import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
/** @vitest-environment jsdom */
import { useState } from "react";
import { MemoryRouter } from "react-router";
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

import { registerTutorialRealm } from "@opensesame/app-core/tutorial/registry/optional-tutorials.test-support.js";

import type { DropItem, SecretItem, VaultItem } from "@opensesame/vault-core";

const store = vi.hoisted(() => ({
  saveItem: vi.fn<(item: VaultItem) => Promise<void>>(),
  purgeItem: vi.fn<(id: string) => Promise<void>>(),
  toggleFavorite: vi.fn<(id: string) => Promise<void>>(),
  trashItem: vi.fn<(id: string) => Promise<void>>(),
  restoreItem: vi.fn<(id: string) => Promise<void>>(),
}));
const createClaim = vi.hoisted(() => vi.fn());
const pollClaim = vi.hoisted(() => vi.fn());

type VaultHarness = {
  current: {
    items: VaultItem[];
    folders: [];
    status: string;
    prefs: {
      autoLockMinutes: number;
      lockOnHide: boolean;
      signOutOnLock: boolean;
      clipboardClearSeconds: number;
      theme: "system";
    };
  };
};

const vault: VaultHarness = {
  current: {
    items: [],
    folders: [],
    status: "locked",
    prefs: {
      autoLockMinutes: 0,
      lockOnHide: false,
      signOutOnLock: false,
      clipboardClearSeconds: 30,
      theme: "system",
    },
  },
};

import { clearNotices, listNotices } from "@opensesame/app-core/lib/notices.js";
import { dropSeams } from "@opensesame/app-core/lib/vault/drop.js";
import { vaultHooksSeams } from "../../lib/vault/hooks.js";
Object.assign(vaultHooksSeams, {
  useVaultStore: () => store,
  useVault: () => vault.current,
});
Object.assign(dropSeams, { createClaim, pollClaim });

import {
  DropRecordFields,
  ShareSecretDrop,
  clockExpiry,
} from "./DropCeremony.js";
import { makeAccount } from "./account.test-support.js";

function sessionFor(claimId = "clm_test") {
  return {
    claimId,
    bearerToken: `osc_clm_${claimId}.secret`,
    userCode: "ABCD-EFGH",
    verifyUrl: "https://pages.example/OpenSesame/claim",
    expiresAt: "2026-08-30T10:00:00.000Z",
  };
}

function makeSecret(overrides: Partial<SecretItem> = {}): SecretItem {
  return {
    id: "itm_secret",
    kind: "secret",
    name: "Deploy token",
    folderId: null,
    favorite: false,
    notes: "",
    fields: [],
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-08-01T00:00:00Z",
    deletedAt: null,
    value: "s3cr3t-value",
    ceiling: [],
    grantees: [],
    connectionRef: "",
    ...overrides,
  };
}

function makeDrop(overrides: Partial<DropItem> = {}): DropItem {
  return {
    id: "itm_drop",
    kind: "drop",
    name: "Deploy token",
    folderId: null,
    favorite: false,
    notes: "",
    fields: [],
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-08-01T00:00:00Z",
    deletedAt: null,
    state: "pending",
    claimId: "clm_test",
    bearerToken: "osc_clm_clm_test.secret",
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    ...overrides,
  };
}

// The Share once key is a tutorial target `sharing.drops` contributes.
let revokeRealm = () => {};
beforeAll(() => {
  revokeRealm = registerTutorialRealm();
});
afterAll(() => revokeRealm());

beforeEach(() => {
  clearNotices();
  for (const mock of Object.values(store)) mock.mockReset();
  store.saveItem.mockResolvedValue(undefined);
  store.purgeItem.mockResolvedValue(undefined);
  createClaim.mockReset();
  createClaim.mockImplementation(async () => sessionFor());
  pollClaim.mockReset();
  pollClaim.mockResolvedValue("pending");
  vault.current = {
    items: [],
    folders: [],
    status: "locked",
    prefs: {
      autoLockMinutes: 0,
      lockOnHide: false,
      signOutOnLock: false,
      clipboardClearSeconds: 30,
      theme: "system",
    },
  };
});

afterEach(() => {
  clearNotices();
  cleanup();
  // beforeEach resets mock state; the seam objects themselves stay injected
  // for the whole file (vitest isolates modules per test file).
  Object.assign(vaultHooksSeams, {
    useVaultStore: () => store,
    useVault: () => vault.current,
  });
  Object.assign(dropSeams, { createClaim, pollClaim });
});

/** The ceremony as ItemDetail drives it: open or closed, closing by `onClose`. */
function Ceremony({
  item,
  startOpen = true,
  onClose,
}: {
  item: VaultItem;
  startOpen?: boolean;
  onClose?: () => void;
}) {
  const [open, setOpen] = useState(startOpen);
  return (
    <MemoryRouter>
      <button type="button" onClick={() => setOpen((value) => !value)}>
        toggle
      </button>
      <ShareSecretDrop
        item={item}
        open={open}
        onClose={() => {
          setOpen(false);
          onClose?.();
        }}
      />
    </MemoryRouter>
  );
}

function expiryRow(): string {
  return screen.getByText("Expires").closest(".frow")?.textContent ?? "";
}

describe("clock expiry", () => {
  const now = Date.parse("2026-08-30T09:00:00.000Z");

  it("adds what is left while the drop is ahead, and the time alone once it has lapsed", () => {
    expect(clockExpiry("2026-08-30T10:00:00.000Z", now)).toMatch(/left$/);
    const past = clockExpiry("2026-08-30T08:00:00.000Z", now);
    expect(past).not.toMatch(/left/);
    expect(past.length).toBeGreaterThan(0);
  });
});

describe("share ceremony on an item", () => {
  it("seals a secret with a TTL and shows the drop card, saving no item", async () => {
    const user = userEvent.setup();
    render(<Ceremony item={makeSecret()} />);

    const ttl = screen.getByRole("radiogroup", { name: "Opens for" });
    expect(ttl.querySelectorAll("button")).toHaveLength(3);
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryByRole("checkbox", { name: /Keep a copy/ })).toBeNull();
    expect(screen.getByText("This browser")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: /Seal and share/i }));
    await screen.findByText("Drop ready");

    expect(
      screen.getByText(/#token=osc_clm_clm_test\.secret&key=/),
    ).toBeTruthy();
    expect(screen.getAllByText("ABCD-EFGH")).toHaveLength(1);
    expect(document.querySelector(".qr__shortcode")).toBeNull();
    expect(screen.queryByText("s3cr3t-value")).toBeNull();
    const ready = screen.getByRole("region", { name: "Drop ready" });
    expect(ready.textContent).toMatch(/Opens for\s*1 hour/);
    expect(ready.textContent).toMatch(/Opens on\s*This browser/);
    expect(expiryRow()).not.toMatch(/left/);
    expect(ready.querySelector("p.hint")).toBeNull();
    expect(screen.queryByRole("link", { name: /drop record/i })).toBeNull();
    expect(store.saveItem).not.toHaveBeenCalled();

    const [manifest] = createClaim.mock.calls[0] ?? [];
    expect(JSON.stringify(manifest)).not.toContain("s3cr3t-value");
  });

  it("draws nothing while closed, and a closed ceremony forgets a finished drop", async () => {
    const user = userEvent.setup();
    render(<Ceremony item={makeSecret()} startOpen={false} />);
    expect(screen.queryByRole("radiogroup")).toBeNull();
    expect(screen.queryByRole("button", { name: "Share once" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "toggle" }));
    await user.click(screen.getByRole("button", { name: /Seal and share/i }));
    await screen.findByText("Drop ready");

    await user.click(screen.getByRole("button", { name: "toggle" }));
    expect(screen.queryByText("Drop ready")).toBeNull();
    await user.click(screen.getByRole("button", { name: "toggle" }));
    expect(screen.queryByText("Drop ready")).toBeNull();
    expect(screen.getByRole("radiogroup", { name: "Opens for" })).toBeTruthy();
  });

  it("presses the one-hour choice at first and seals for the choice in force", async () => {
    const user = userEvent.setup();
    render(<Ceremony item={makeSecret()} />);
    const pressed = (name: string) =>
      screen.getByRole("button", { name }).getAttribute("aria-pressed");
    expect(pressed("1 hour")).toBe("true");
    expect(pressed("10 minutes")).toBe("false");
    const hourExpiry = expiryRow();
    expect(hourExpiry).toMatch(/left$/);

    await user.click(screen.getByRole("button", { name: "1 day" }));
    expect(pressed("1 day")).toBe("true");
    expect(pressed("1 hour")).toBe("false");
    expect(expiryRow()).not.toBe(hourExpiry);
    expect(expiryRow()).toMatch(/left$/);

    await user.click(screen.getByRole("button", { name: /Seal and share/i }));
    await screen.findByText("Drop ready");
    expect(createClaim.mock.calls[0]?.[1]).toBe(86_400_000);
    expect(
      screen.getByRole("region", { name: "Drop ready" }).textContent,
    ).toMatch(/Opens for\s*1 day/);
    expect(expiryRow()).not.toMatch(/left/);
    expect(screen.queryByRole("radiogroup")).toBeNull();
  });

  it("keeps a failed seal in the tray and leaves the form up", async () => {
    const user = userEvent.setup();
    createClaim.mockRejectedValue(new Error("The drop was not created."));
    render(<Ceremony item={makeSecret()} />);
    await user.click(screen.getByRole("button", { name: /Seal and share/i }));
    await waitFor(() =>
      expect(listNotices()[0]).toMatchObject({
        id: "vault:drop:itm_secret",
        title: "Drop",
        body: "The drop was not created.",
        tone: "err",
      }),
    );
    expect(screen.queryByRole("alert")).toBeNull();
    expect(document.querySelector(".note--err")).toBeNull();
    expect(screen.queryByText("Drop ready")).toBeNull();
    expect(screen.getByRole("radiogroup", { name: "Opens for" })).toBeTruthy();
  });

  it("takes focus on the choice in force when it opens, and Cancel closes it", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <Ceremony item={makeSecret()} startOpen={false} onClose={onClose} />,
    );
    await user.click(screen.getByRole("button", { name: "toggle" }));
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "1 hour" }),
    );

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(screen.queryByRole("radiogroup")).toBeNull();
  });

  it("is reached and left by keyboard alone", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <Ceremony item={makeSecret()} startOpen={false} onClose={onClose} />,
    );
    screen.getByRole("button", { name: "toggle" }).focus();
    await user.keyboard("{Enter}");
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "1 hour" }),
    );
    await user.keyboard("{ArrowRight}");
    await user.tab();
    await user.tab();
    await user.tab();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Cancel" }),
    );
    await user.keyboard("{Enter}");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("seals an account password the same way", async () => {
    const user = userEvent.setup();
    render(
      <Ceremony
        item={makeAccount({
          id: "itm_login",
          name: "GitHub",
          username: "octocat",
          password: "hunter2-login",
        })}
      />,
    );
    await user.click(screen.getByRole("button", { name: /Seal and share/i }));
    await screen.findByText("Drop ready");
    expect(store.saveItem).not.toHaveBeenCalled();
    const [manifest] = createClaim.mock.calls[0] ?? [];
    expect(JSON.stringify(manifest)).not.toContain("hunter2-login");
  });
});

describe("disposal", () => {
  it("shows state and countdown on the drop record", () => {
    render(
      <MemoryRouter>
        <DropRecordFields item={makeDrop()} />
      </MemoryRouter>,
    );
    expect(screen.getByText("Waiting to be opened")).toBeTruthy();
    expect(screen.getByText(/left$/)).toBeTruthy();
  });

  it("purges the record when the poll says the drop was opened", async () => {
    pollClaim.mockResolvedValue("consumed");
    render(
      <MemoryRouter>
        <DropRecordFields item={makeDrop()} />
      </MemoryRouter>,
    );
    await waitFor(() =>
      expect(store.purgeItem).toHaveBeenCalledWith("itm_drop"),
    );
  });

  it("keeps the record while the poll is pending", async () => {
    pollClaim.mockResolvedValue("pending");
    render(
      <MemoryRouter>
        <DropRecordFields item={makeDrop()} />
      </MemoryRouter>,
    );
    await screen.findByText("Waiting to be opened");
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(store.purgeItem).not.toHaveBeenCalled();
  });
});
