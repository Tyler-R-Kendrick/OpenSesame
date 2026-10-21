/** @vitest-environment jsdom */
import {
  TRANSPORT_PATH,
  readLiveTransport,
  storeSeams,
} from "@opensesame/app-core/lib/live/transport-store.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { VfsError } from "@opensesame/app-core/lib/vfs.js";
import { TRANSPORT_FILE } from "@opensesame/app-core/sections/settings/live-transport-files.js";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { vaultHooksSeams } from "../../lib/vault/hooks.js";
import { LiveSharePanel } from "./LiveSharePanel.js";
import { transportSeams } from "./live-transport-hooks.js";

const original = {
  store: { ...storeSeams },
  hooks: { ...vaultHooksSeams },
  transport: { ...transportSeams },
};
const stored = new Map<string, Uint8Array>();
let tomb = "personal";
let unlocked = true;
let writes = 0;

beforeEach(() => {
  tomb = "personal";
  unlocked = true;
  writes = 0;
  stored.clear();
  Object.assign(storeSeams, {
    refresh: async () => undefined,
    read: async (at: string) => {
      const text = stored.get(`${at}/${TRANSPORT_PATH}`);
      if (!text) throw new VfsError("not-found", "none");
      return text;
    },
    write: async (at: string, bytes: Uint8Array) => {
      writes += 1;
      stored.set(`${at}/${TRANSPORT_PATH}`, bytes);
    },
  });
  Object.assign(vaultHooksSeams, {
    useVault: () => ({
      ...vaultStore.getSnapshot(),
      tomb,
      status: unlocked ? "unlocked" : "locked",
    }),
  });
  Object.assign(transportSeams, { tomb: () => tomb });
});

afterEach(() => {
  cleanup();
  Object.assign(storeSeams, original.store);
  Object.assign(vaultHooksSeams, original.hooks);
  Object.assign(transportSeams, original.transport);
});

async function openFile() {
  fireEvent.click(
    await screen.findByRole("button", { name: "Open transport.json" }),
  );
  const field = screen.getByRole("textbox", { name: TRANSPORT_FILE });
  await waitFor(() => expect(field.hasAttribute("readonly")).toBe(false));
  return field;
}

function advanced(container: HTMLElement) {
  const details = container.querySelector("details");
  if (!(details instanceof HTMLDetailsElement)) throw new Error("no Advanced");
  details.open = true;
}

const profile = {
  ice: [
    { urls: ["turns:turn.example.test:443"], secret: "turn-rest-secret-4417" },
  ],
  relay: true,
};

describe("Share Advanced's transport file", () => {
  it("opens the real provider, saves a TURN REST profile, and reads it after reopening", async () => {
    const view = render(<LiveSharePanel />);
    advanced(view.container);
    const field = await openFile();
    expect(field).toHaveProperty("value", "{}\n");
    fireEvent.change(field, { target: { value: JSON.stringify(profile) } });
    fireEvent.click(
      screen.getByRole("button", { name: `Save ${TRANSPORT_FILE}` }),
    );
    await screen.findByText(`Saved ${TRANSPORT_FILE}.`);
    expect((await readLiveTransport(tomb)).ice[0]?.secret).toBe(
      "turn-rest-secret-4417",
    );
    fireEvent.click(screen.getByRole("button", { name: "Back to routes" }));
    await screen.findByText("turns:turn.example.test:443");
    expect(view.container.textContent).not.toContain("turn-rest-secret-4417");
    const reopened = await openFile();
    expect(reopened).toHaveProperty(
      "value",
      new TextDecoder().decode(stored.get(`${tomb}/${TRANSPORT_PATH}`)),
    );
    expect(writes).toBe(1);
  });

  it("refuses malformed and relay-only-without-TURN drafts without replacing the stored profile", async () => {
    const view = render(<LiveSharePanel />);
    advanced(view.container);
    const field = await openFile();
    for (const draft of ["{", '{"relay":true}']) {
      fireEvent.change(field, { target: { value: draft } });
      expect(field.getAttribute("aria-invalid")).toBe("true");
      expect(
        screen
          .getByRole("button", { name: `Save ${TRANSPORT_FILE}` })
          .hasAttribute("disabled"),
      ).toBe(true);
    }
    expect(writes).toBe(0);
    expect(stored.size).toBe(0);
  });

  it("withdraws the old draft on vault change and removes the editor on lock", async () => {
    const view = render(<LiveSharePanel />);
    advanced(view.container);
    const field = await openFile();
    fireEvent.change(field, { target: { value: JSON.stringify(profile) } });
    tomb = "household";
    view.rerender(<LiveSharePanel />);
    expect(screen.queryByRole("textbox", { name: TRANSPORT_FILE })).toBeNull();
    expect(await openFile()).toHaveProperty("value", "{}\n");
    unlocked = false;
    view.rerender(<LiveSharePanel />);
    expect(screen.queryByRole("textbox", { name: TRANSPORT_FILE })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Open transport.json" }),
    ).toBeNull();
    expect(writes).toBe(0);
  });
});
