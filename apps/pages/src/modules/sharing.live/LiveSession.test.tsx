/** @vitest-environment jsdom */
/**
 * A live session through the screens people use (ADR 0150): the owner's
 * Settings panel starts it, the joiner's `/live` screen asks, the owner lets
 * them in, and a concealed value crosses only when asked for. The two sealed
 * pairing codes are passed by hand, as people pass them; no server of any
 * kind is involved. The peers are fakes (real WebRTC: verify:live-join).
 */
import { holdLiveLink } from "@opensesame/app-core/lib/live/link.js";
import { FakeNet } from "@opensesame/app-core/lib/live/live-fakes.js";
import {
  currentGuest,
  currentHost,
  endHosting,
  leaveLive,
  liveSeams,
} from "@opensesame/app-core/lib/live/session.js";
import { DIRECT_TRANSPORT } from "@opensesame/app-core/lib/live/transport.js";
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
import { withPassword } from "../../sections/vault/account.test-support.js";
import { LiveHostPanel } from "./LiveHostPanel.js";
import { LiveJoinRoute } from "./LiveJoinRoute.js";
import { clearJoinDraft, liveUiSeams } from "./live-hooks.js";
import { transportSeams } from "./live-transport-hooks.js";

const SECRET = "correct horse battery staple";
const github = createItem("account", "GitHub");
github.username = "octo";
withPassword(github, SECRET);
const bank = createItem("account", "Bank");
withPassword(bank, "not shared");

const originalHooks = { ...vaultHooksSeams };
const originalLive = { ...liveSeams };
const originalUi = { ...liveUiSeams };
const originalTransport = { ...transportSeams };
let net: FakeNet;

beforeEach(() => {
  Object.assign(transportSeams, {
    tomb: () => "personal",
    read: async () => DIRECT_TRANSPORT,
  });
  net = new FakeNet();
  Object.assign(vaultHooksSeams, {
    useVault: () => ({
      ...vaultStore.getSnapshot(),
      status: "unlocked" as const,
      items: [github, bank],
    }),
    useCopySecret: () => async () => "copied" as const,
  });
  Object.assign(liveSeams, {
    items: () => [github, bank],
  });
  Object.assign(liveUiSeams, {
    peers: net.factory(),
    joinUrl: () => "https://example.test/OpenSesame/",
  });
});

afterEach(() => {
  clearJoinDraft();
  leaveLive();
  endHosting();
  cleanup();
  Object.assign(vaultHooksSeams, originalHooks);
  Object.assign(liveSeams, originalLive);
  Object.assign(liveUiSeams, originalUi);
  Object.assign(transportSeams, originalTransport);
});

async function startHosting(
  admission: "invite" | "open" = "invite",
  values: "read" | "use" | "edit" = "read",
) {
  const { container } = render(<LiveHostPanel />);
  const owner = container;
  const panel = within(owner);
  // The routes are read from the vault before a session can start.
  await panel.findByRole("img", { name: "Direct only" });
  fireEvent.change(panel.getByLabelText("Session name"), {
    target: { value: "Team" },
  });
  fireEvent.click(panel.getByRole("checkbox", { name: "GitHub" }));
  fireEvent.change(panel.getByLabelText("Values"), {
    target: { value: values },
  });
  fireEvent.change(panel.getByLabelText("Who gets in"), {
    target: { value: admission },
  });
  fireEvent.click(
    panel.getByRole("button", { name: "Start the live session" }),
  );
  return { owner, panel };
}

function openJoin(): HTMLElement {
  const { container } = render(
    <MemoryRouter>
      <LiveJoinRoute />
    </MemoryRouter>,
  );
  return container;
}

/** The joiner asks: the request code the page made for them to send. */
async function ask(joiner: ReturnType<typeof within>, name: string) {
  fireEvent.change(joiner.getByLabelText("Your name"), {
    target: { value: name },
  });
  fireEvent.click(joiner.getByRole("button", { name: "Ask to join" }));
  await joiner.findByRole("button", { name: "Copy your request code" });
  const status = currentGuest()?.status;
  return status?.at === "request" ? status.code : "";
}

/** A code, pasted into a labelled field and committed with its key. */
function paste(
  where: ReturnType<typeof within>,
  label: string,
  key: string,
  text: string,
) {
  fireEvent.change(where.getByLabelText(label), { target: { value: text } });
  fireEvent.click(where.getByRole("button", { name: key }));
}

describe("a live session, owner to joiner, paired by hand", () => {
  it("lets in a joiner who holds the link and the code, and hands over one value on request", async () => {
    const { owner, panel } = await startHosting();
    await panel.findByRole("img", { name: "Live" });
    const host = currentHost();
    expect(host?.code).toMatch(/^[A-Z]{4}-[A-Z]{4}$/);

    holdLiveLink(host?.link ?? null);
    const joiner = within(openJoin());
    expect(joiner.getByRole("img", { name: "Link in hand" })).toBeTruthy();
    fireEvent.change(joiner.getByLabelText("Code"), {
      target: { value: (host?.code ?? "").toLowerCase() },
    });
    const request = await ask(joiner, "Ada Lovelace");
    expect(request).toMatch(/^osl-request\./);
    // A space cannot appear in a base64url code by chance.
    expect(request).not.toContain("Ada Lovelace");

    const created = net.created;
    paste(panel, "A request code", "Read the request", request);
    const admit = await panel.findByRole("button", {
      name: "Let Ada Lovelace in",
    });
    // Asking made the owner no peer: nothing of the owner has left yet.
    expect(net.created).toBe(created);
    fireEvent.click(admit);
    await panel.findByRole("button", {
      name: "Copy the reply code for Ada Lovelace",
    });
    const reply = currentHost()?.state.guests[0]?.reply ?? "";
    expect(reply).toMatch(/^osl-reply\./);

    paste(joiner, "The owner's reply code", "Connect", reply);
    await joiner.findByRole("img", { name: "Joined Team" });
    expect(joiner.getByText("octo")).toBeTruthy();
    expect(joiner.queryByText("Bank")).toBeNull();
    expect(joiner.queryByText(SECRET)).toBeNull();

    fireEvent.click(
      joiner.getByRole("button", { name: "Reveal GitHub Password" }),
    );
    await waitFor(() => expect(joiner.getByText(SECRET)).toBeTruthy());
    await panel.findByRole("list", { name: "Handed out" });

    // Ending it drops everything the joiner held.
    const ownerPanel = within(owner);
    fireEvent.click(
      ownerPanel.getByRole("button", {
        name: "End the session for everyone",
      }),
    );
    fireEvent.click(ownerPanel.getByRole("button", { name: "End for everyone" }));
    await joiner.findByRole("img", { name: "The session ended" });
    expect(joiner.queryByText(SECRET)).toBeNull();
    expect(joiner.queryByText("octo")).toBeNull();
  });

  it("counts a request made with the wrong code, and says so", async () => {
    const { panel } = await startHosting();
    await panel.findByRole("img", { name: "Live" });
    const host = currentHost();
    holdLiveLink(host?.link ?? null);
    const joiner = within(openJoin());
    fireEvent.change(joiner.getByLabelText("Code"), {
      target: { value: host?.code === "BCDF-GHJK" ? "BCDF-GHJL" : "BCDF-GHJK" },
    });
    const request = await ask(joiner, "Mallory");
    paste(panel, "A request code", "Read the request", request);
    await panel.findByRole("img", { name: "Not for this session (1 of 5)" });
    expect(panel.queryByText("Mallory")).toBeNull();
  });

  it("refuses a reply that is not for this request", async () => {
    const { panel } = await startHosting();
    await panel.findByRole("img", { name: "Live" });
    holdLiveLink(currentHost()?.link ?? null);
    const joiner = within(openJoin());
    fireEvent.change(joiner.getByLabelText("Code"), {
      target: { value: currentHost()?.code ?? "" },
    });
    await ask(joiner, "Ada");
    paste(joiner, "The owner's reply code", "Connect", "osl-reply.nope.nope");
    await joiner.findByRole("img", {
      name: "That reply is not for this request",
    });
  });

  it("copy only does not write secret plaintext to the guest clipboard", async () => {
    const written: string[] = [];
    Object.assign(vaultHooksSeams, {
      useVault: () => ({
        ...vaultStore.getSnapshot(),
        status: "unlocked" as const,
        items: [github, bank],
      }),
      useCopySecret: () => async (value: string) => {
        written.push(value);
        return "copied" as const;
      },
    });
    const { panel } = await startHosting("invite", "use");
    await panel.findByRole("img", { name: "Live" });
    const host = currentHost();
    holdLiveLink(host?.link ?? null);
    const joiner = within(openJoin());
    fireEvent.change(joiner.getByLabelText("Code"), {
      target: { value: host?.code ?? "" },
    });
    const request = await ask(joiner, "Ada Lovelace");
    paste(panel, "A request code", "Read the request", request);
    fireEvent.click(
      await panel.findByRole("button", { name: "Let Ada Lovelace in" }),
    );
    await panel.findByRole("button", {
      name: "Copy the reply code for Ada Lovelace",
    });
    paste(
      joiner,
      "The owner's reply code",
      "Connect",
      currentHost()?.state.guests[0]?.reply ?? "",
    );
    await joiner.findByRole("img", { name: "Joined Team" });
    expect(joiner.queryByText(SECRET)).toBeNull();
    const copyPassword = joiner.queryByRole("button", {
      name: "Copy GitHub Password",
    });
    if (copyPassword) fireEvent.click(copyPassword);
    expect(copyPassword).toBeNull();
    expect(
      joiner.queryByRole("button", { name: "Reveal GitHub Password" }),
    ).toBeNull();
    expect(written).not.toContain(SECRET);
  });

  it("asks for no code in an open session, and replies at once", async () => {
    const { panel } = await startHosting("open");
    await panel.findByRole("img", { name: "Live" });
    const host = currentHost();
    expect(host?.code).toBeNull();
    holdLiveLink(host?.link ?? null);
    const joiner = within(openJoin());
    expect(joiner.queryByLabelText("Code")).toBeNull();
    const request = await ask(joiner, "Grace");
    paste(panel, "A request code", "Read the request", request);
    await panel.findByRole("button", { name: "Copy the reply code for Grace" });
    expect(panel.queryByRole("button", { name: "Let Grace in" })).toBeNull();
    paste(
      joiner,
      "The owner's reply code",
      "Connect",
      currentHost()?.state.guests[0]?.reply ?? "",
    );
    await joiner.findByRole("img", { name: "Joined Team" });
    expect(
      joiner.getByRole("button", { name: "Copy GitHub Password" }),
    ).toBeTruthy();
  });

  it("keeps what the joiner typed when the screen mounts again", async () => {
    // Committing the join road's consent re-plans the page, and the screen
    // can mount a second time after the person has started typing.
    const { panel } = await startHosting();
    await panel.findByRole("img", { name: "Live" });
    holdLiveLink(currentHost()?.link ?? null);
    const first = render(
      <MemoryRouter>
        <LiveJoinRoute />
      </MemoryRouter>,
    );
    const typed = within(first.container);
    fireEvent.change(typed.getByLabelText("Code"), {
      target: { value: currentHost()?.code ?? "" },
    });
    fireEvent.change(typed.getByLabelText("Your name"), {
      target: { value: "Ada" },
    });
    first.unmount();
    const again = within(openJoin());
    expect(again.getByRole("img", { name: "Link in hand" })).toBeTruthy();
    expect(again.getByLabelText<HTMLInputElement>("Your name").value).toBe(
      "Ada",
    );
    expect(
      again
        .getByRole("button", { name: /^Ask to join$/ })
        .hasAttribute("disabled"),
    ).toBe(false);
  });

  it("says why when this browser cannot make a request, and keeps what was typed", async () => {
    const { panel } = await startHosting();
    await panel.findByRole("img", { name: "Live" });
    holdLiveLink(currentHost()?.link ?? null);
    liveUiSeams.peers = () => {
      throw new Error("no WebRTC here");
    };
    const joiner = within(openJoin());
    fireEvent.change(joiner.getByLabelText("Code"), {
      target: { value: currentHost()?.code ?? "" },
    });
    fireEvent.change(joiner.getByLabelText("Your name"), {
      target: { value: "Ada" },
    });
    fireEvent.click(joiner.getByRole("button", { name: "Ask to join" }));
    await joiner.findByRole("img", {
      name: "This browser could not make a request code",
    });
    expect(joiner.getByLabelText<HTMLInputElement>("Your name").value).toBe(
      "Ada",
    );
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
    const ask = joiner.getByRole("button", {
      name: /Ask to join\. Paste a live-session link that parses/,
    });
    expect(ask.hasAttribute("disabled")).toBe(true);
  });
});
