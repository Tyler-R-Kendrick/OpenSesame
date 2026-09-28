/** @vitest-environment jsdom */
/**
 * A live session through the screens people use (ADR 0148): the owner's
 * Settings panel starts it, the joiner's `/live` screen asks, the owner lets
 * them in, and a concealed value crosses only when asked for — over a relay
 * that carries the real signed, encrypted events, between fake peers.
 */
import { holdLiveLink } from "@opensesame/app-core/lib/live/link.js";
import {
  FakeNet,
  MemoryRelay,
} from "@opensesame/app-core/lib/live/live-fakes.js";
import {
  currentHost,
  endHosting,
  leaveLive,
  liveSeams,
} from "@opensesame/app-core/lib/live/session.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { createItem } from "@opensesame/vault-core";
import {
  cleanup,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { vaultHooksSeams } from "../../lib/vault/hooks.js";
import { LiveHostPanel } from "./LiveHostPanel.js";
import { LiveJoinRoute } from "./LiveJoinRoute.js";
import { liveUiSeams } from "./live-hooks.js";

const SECRET = "correct horse battery staple";
const github = createItem("login", "GitHub");
github.username = "octo";
github.password = SECRET;
const bank = createItem("login", "Bank");
bank.password = "not shared";

const originalHooks = { ...vaultHooksSeams };
const originalLive = { ...liveSeams };
const originalUi = { ...liveUiSeams };
let relay: MemoryRelay;

beforeEach(() => {
  relay = new MemoryRelay();
  const net = new FakeNet();
  Object.assign(vaultHooksSeams, {
    useVault: () => ({
      ...vaultStore.getSnapshot(),
      status: "unlocked" as const,
      items: [github, bank],
    }),
    useCopySecret: () => async () => "copied" as const,
  });
  Object.assign(liveSeams, {
    transport: () => relay.transport(),
    items: () => [github, bank],
  });
  Object.assign(liveUiSeams, {
    peers: net.factory(),
    joinUrl: () => "https://example.test/OpenSesame/live",
  });
});

afterEach(() => {
  leaveLive();
  endHosting();
  cleanup();
  Object.assign(vaultHooksSeams, originalHooks);
  Object.assign(liveSeams, originalLive);
  Object.assign(liveUiSeams, originalUi);
});

function startHosting(admission: "invite" | "open" = "invite") {
  const { container } = render(<LiveHostPanel />);
  const owner = container;
  const panel = within(owner);
  fireEvent.change(panel.getByLabelText("Session name"), {
    target: { value: "Team" },
  });
  fireEvent.click(panel.getByRole("checkbox", { name: "GitHub" }));
  fireEvent.change(panel.getByLabelText("Values"), {
    target: { value: "read" },
  });
  fireEvent.change(panel.getByLabelText("Who gets in"), {
    target: { value: admission },
  });
  fireEvent.click(
    panel.getByRole("button", { name: "Start the live session" }),
  );
  return { owner };
}

function openJoin(): HTMLElement {
  const { container } = render(
    <MemoryRouter>
      <LiveJoinRoute />
    </MemoryRouter>,
  );
  return container;
}

describe("a live session, owner to joiner", () => {
  it("admits a joiner who holds the link and the code, and hands over one value on request", async () => {
    const { owner } = startHosting();
    const host = currentHost();
    expect(host?.code).toMatch(/^[A-Z]{4}-[A-Z]{4}$/);
    expect(within(owner).getByRole("img", { name: "Live" })).toBeTruthy();

    holdLiveLink(host?.link ?? null);
    const joiner = within(openJoin());
    expect(joiner.getByRole("img", { name: "Link in hand" })).toBeTruthy();
    fireEvent.change(joiner.getByLabelText("Code"), {
      target: { value: (host?.code ?? "").toLowerCase() },
    });
    fireEvent.change(joiner.getByLabelText("Your name"), {
      target: { value: "Ada" },
    });
    fireEvent.click(joiner.getByRole("button", { name: "Ask to join" }));

    // Asking reveals nothing about the owner: no peer until admitted.
    const admit = await within(owner).findByRole("button", {
      name: "Let Ada in",
    });
    fireEvent.click(admit);

    await waitFor(() =>
      expect(joiner.getByRole("img", { name: "Joined Team" })).toBeTruthy(),
    );
    expect(joiner.getByText("octo")).toBeTruthy();
    expect(joiner.queryByText("Bank")).toBeNull();
    expect(joiner.queryByText(SECRET)).toBeNull();

    fireEvent.click(
      joiner.getByRole("button", { name: "Reveal GitHub Password" }),
    );
    await waitFor(() => expect(joiner.getByText(SECRET)).toBeTruthy());
    // The owner sees what was handed out.
    await waitFor(() =>
      expect(
        within(owner).getByRole("list", { name: "Handed out" }),
      ).toBeTruthy(),
    );
    // Relays carried ciphertext only.
    const wire = JSON.stringify(relay.seen);
    for (const leak of [SECRET, "octo", "Ada", host?.code ?? "?"])
      expect(wire).not.toContain(leak);

    // Ending it drops everything the joiner held.
    fireEvent.click(
      within(owner).getByRole("button", {
        name: "End the session for everyone",
      }),
    );
    await waitFor(() =>
      expect(
        joiner.getByRole("img", { name: "The session ended" }),
      ).toBeTruthy(),
    );
    expect(joiner.queryByText(SECRET)).toBeNull();
    expect(joiner.queryByText("octo")).toBeNull();
  });

  it("refuses a joiner with the wrong code", async () => {
    startHosting();
    const host = currentHost();
    holdLiveLink(host?.link ?? null);
    const joiner = within(openJoin());
    fireEvent.change(joiner.getByLabelText("Code"), {
      target: { value: "BCDF-GHJK" === host?.code ? "BCDF-GHJL" : "BCDF-GHJK" },
    });
    fireEvent.change(joiner.getByLabelText("Your name"), {
      target: { value: "Mallory" },
    });
    fireEvent.click(joiner.getByRole("button", { name: "Ask to join" }));
    await waitFor(() =>
      expect(
        joiner.getByRole("img", { name: "That code is not this session's" }),
      ).toBeTruthy(),
    );
  });

  it("asks for no code in an open session, and lets the link holder straight in", async () => {
    const { owner } = startHosting("open");
    const host = currentHost();
    expect(host?.code).toBeNull();
    expect(within(owner).queryByText(/^[A-Z]{4}-[A-Z]{4}$/)).toBeNull();
    holdLiveLink(host?.link ?? null);
    const joiner = within(openJoin());
    expect(joiner.queryByLabelText("Code")).toBeNull();
    fireEvent.change(joiner.getByLabelText("Your name"), {
      target: { value: "Grace" },
    });
    fireEvent.click(joiner.getByRole("button", { name: "Ask to join" }));
    await waitFor(() =>
      expect(joiner.getByRole("img", { name: "Joined Team" })).toBeTruthy(),
    );
    // `read` was chosen, so a reveal key is drawn beside copy.
    expect(
      joiner.getByRole("button", { name: "Copy GitHub Password" }),
    ).toBeTruthy();
  });

  it("takes a pasted link masked, and says when it is not one", () => {
    const joiner = within(openJoin());
    const field = joiner.getByLabelText<HTMLInputElement>("Link");
    expect(field.type).toBe("password");
    fireEvent.change(field, {
      target: { value: "https://example.test/#nope" },
    });
    expect(
      joiner.getByRole("img", { name: "Not a live-session link" }),
    ).toBeTruthy();
    expect(
      joiner
        .getByRole("button", { name: "Ask to join" })
        .hasAttribute("disabled"),
    ).toBe(true);
  });
});
