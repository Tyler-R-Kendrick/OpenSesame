/** @vitest-environment jsdom */
/**
 * Where the keyboard is after each swap in a live session (AGENTS.md §5).
 *
 * Asking, Connect, Start, End, Start over, Let in and Turn away each take the
 * focused control out of the document or disable it, so the next Tab would
 * start at the top. Each test focuses that control, drives the change, and
 * reads `activeElement`. A person who moved on by mouse keeps their focus.
 *
 * A browser drops the focus of a control that is disabled while it holds it;
 * jsdom does not, so `browserFocusFixup` says so, as Chromium does.
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
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { vaultHooksSeams } from "../../lib/vault/hooks.js";
import { withPassword } from "../../sections/vault/account.test-support.js";
import { LiveHostPanel } from "./LiveHostPanel.js";
import { LiveJoinRoute } from "./LiveJoinRoute.js";
import { clearJoinDraft, liveUiSeams } from "./live-hooks.js";
import { transportSeams } from "./live-transport-hooks.js";

const github = createItem("account", "GitHub");
github.username = "octo";
withPassword(github, "correct horse battery staple");

const originalHooks = { ...vaultHooksSeams };
const originalLive = { ...liveSeams };
const originalUi = { ...liveUiSeams };
const originalTransport = { ...transportSeams };
let net: FakeNet;
let fixup: MutationObserver;

/** What a browser does when the control holding the keyboard is disabled. */
function browserFocusFixup(): MutationObserver {
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      const held = document.activeElement;
      if (record.target !== held || !(held instanceof HTMLElement)) continue;
      if (!held.hasAttribute("disabled")) continue;
      // jsdom will not blur what is disabled: enable it for the instant.
      held.removeAttribute("disabled");
      held.blur();
      held.setAttribute("disabled", "");
    }
  });
  observer.observe(document.body, {
    attributes: true,
    attributeFilter: ["disabled"],
    subtree: true,
  });
  return observer;
}

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
      items: [github],
    }),
    useCopySecret: () => async () => "copied" as const,
  });
  Object.assign(liveSeams, { items: () => [github] });
  Object.assign(liveUiSeams, {
    peers: net.factory(),
    joinUrl: () => "https://example.test/OpenSesame/",
  });
  fixup = browserFocusFixup();
});

afterEach(() => {
  vi.restoreAllMocks();
  fixup.disconnect();
  clearJoinDraft();
  leaveLive();
  endHosting();
  cleanup();
  Object.assign(vaultHooksSeams, originalHooks);
  Object.assign(liveSeams, originalLive);
  Object.assign(liveUiSeams, originalUi);
  Object.assign(transportSeams, originalTransport);
});

/** Focus what a keyboard user is on, then press it. */
function press(element: HTMLElement) {
  act(() => element.focus());
  fireEvent.click(element);
}

/** Submit the form around a field, as a click on its key does. */
function submit(field: HTMLElement) {
  const form = field.closest("form");
  if (!form) throw new Error("a field with no form");
  fireEvent.submit(form);
}

/** Focus a field, then submit its form the way Enter does. */
function enter(field: HTMLElement) {
  act(() => field.focus());
  submit(field);
}

function type(field: HTMLElement, value: string) {
  fireEvent.change(field, { target: { value } });
}

const held = () => document.activeElement;

/** The keyboard is on `element` now, or lands on it a beat after the swap. */
async function landsOn(element: Element | null | undefined) {
  await waitFor(() => expect(held()).toBe(element));
}

async function host(
  admission: "invite" | "open" = "invite",
  values: "read" | "use" | "edit" = "use",
) {
  const rendered = render(<LiveHostPanel />);
  const panel = within(rendered.container);
  await panel.findByRole("img", { name: "Direct only" });
  type(panel.getByLabelText("Session name"), "Team");
  fireEvent.click(panel.getByRole("checkbox", { name: "GitHub" }));
  if (values !== "use") type(panel.getByLabelText("Values"), values);
  type(panel.getByLabelText("Who gets in"), admission);
  return panel;
}

function openJoin() {
  const { container } = render(
    <MemoryRouter>
      <LiveJoinRoute />
    </MemoryRouter>,
  );
  return within(container);
}

/** A live session, hosted and its link held: the joiner's screen is open. */
async function hosted(values: "read" | "use" | "edit" = "use") {
  const panel = await host("invite", values);
  press(panel.getByRole("button", { name: "Start the live session" }));
  await panel.findByRole("img", { name: "Live" });
  const session = currentHost();
  holdLiveLink(session?.link ?? null);
  return { panel, session };
}

async function asked(joiner: ReturnType<typeof within>, code: string) {
  type(joiner.getByLabelText("Code"), code);
  type(joiner.getByLabelText("Your name"), "Ada");
  enter(joiner.getByLabelText("Your name"));
  await joiner.findByRole("button", { name: "Copy your request code" });
  const status = currentGuest()?.status;
  return status?.at === "request" ? status.code : "";
}

/** Owner and joiner paired by hand, the joiner in the session. */
async function pairedJoiner(values: "read" | "use" | "edit" = "use") {
  const { panel, session } = await hosted(values);
  const joiner = openJoin();
  const request = await asked(joiner, session?.code ?? "");
  type(panel.getByLabelText("A request code"), request);
  enter(panel.getByLabelText("A request code"));
  press(await panel.findByRole("button", { name: "Let Ada in" }));
  await panel.findByRole("button", { name: "Copy the reply code for Ada" });
  const field = joiner.getByLabelText("The owner's reply code");
  type(field, currentHost()?.state.guests[0]?.reply ?? "");
  enter(field);
  await joiner.findByRole("img", { name: "Joined Team" });
  return joiner;
}

describe("the keyboard after the host's swaps", () => {
  it("lands on the copy key when Start opens the session, and on the form when End closes it", async () => {
    const panel = await host();
    press(panel.getByRole("button", { name: "Start the live session" }));
    const copy = await panel.findByRole("button", { name: "Copy the link" });
    await landsOn(copy);
    press(panel.getByRole("button", { name: "End the session for everyone" }));
    press(panel.getByRole("button", { name: "End for everyone" }));
    const name = await panel.findByLabelText("Session name");
    await landsOn(name);
  });

  it("brings the copy key out from under the phone's sticky strip when Start shortens the page", async () => {
    const panel = await host();
    const pane = document.body.firstElementChild;
    if (!(pane instanceof HTMLElement)) throw new Error("no pane to scroll");
    const strip = pane.appendChild(document.createElement("nav"));
    strip.className = "page-index";
    strip.style.position = "sticky";
    pane.style.overflowY = "auto";
    Object.defineProperty(pane, "scrollHeight", { value: 2000 });
    Object.defineProperty(pane, "clientHeight", { value: 640 });
    pane.scrollTop = 100; // the key sits at -2px on screen
    const rect = (top: number, height: number) =>
      new DOMRect(0, top, 0, height);
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
      function (this: Element) {
        if (this === pane) return rect(0, 640);
        if (this === strip) return rect(0, 52);
        return rect(98 - pane.scrollTop, 44);
      },
    );
    press(panel.getByRole("button", { name: "Start the live session" }));
    await landsOn(await panel.findByRole("button", { name: "Copy the link" }));
    expect(pane.scrollTop).toBe(38);
  });

  it("leaves a mouse user where they are when the session starts", async () => {
    const panel = await host();
    const elsewhere = document.createElement("button");
    document.body.append(elsewhere);
    act(() => elsewhere.focus());
    fireEvent.click(
      panel.getByRole("button", { name: "Start the live session" }),
    );
    await panel.findByRole("img", { name: "Live" });
    await landsOn(elsewhere);
    elsewhere.remove();
  });

  it("returns to the request field after a paste, and lands on the reply code after Let in", async () => {
    const { panel, session } = await hosted();
    const joiner = openJoin();
    const request = await asked(joiner, session?.code ?? "");
    const field = panel.getByLabelText("A request code");
    type(field, request);
    enter(field);
    const letIn = await panel.findByRole("button", { name: "Let Ada in" });
    await landsOn(panel.getByLabelText("A request code"));
    press(letIn);
    const reply = await panel.findByRole("button", {
      name: "Copy the reply code for Ada",
    });
    await landsOn(reply);
  });

  it("returns to the request field after Turn away, and after a code it cannot read", async () => {
    const { panel, session } = await hosted();
    const joiner = openJoin();
    const request = await asked(joiner, session?.code ?? "");
    const field = panel.getByLabelText("A request code");
    type(field, "not a code");
    enter(field);
    await panel.findByRole("img", { name: "Not a request code" });
    await landsOn(panel.getByLabelText("A request code"));
    type(panel.getByLabelText("A request code"), request);
    enter(panel.getByLabelText("A request code"));
    press(await panel.findByRole("button", { name: "Turn Ada away" }));
    await panel.findByRole("img", { name: "Turned away" });
    await landsOn(panel.getByLabelText("A request code"));
  });

  it("does not move a mouse user's focus when a guest is turned away", async () => {
    const { panel, session } = await hosted();
    const joiner = openJoin();
    const request = await asked(joiner, session?.code ?? "");
    type(panel.getByLabelText("A request code"), request);
    enter(panel.getByLabelText("A request code"));
    const away = await panel.findByRole("button", { name: "Turn Ada away" });
    const other = document.createElement("input");
    document.body.append(other);
    act(() => other.focus());
    fireEvent.click(away);
    await panel.findByRole("img", { name: "Turned away" });
    await landsOn(other);
    other.remove();
  });
});

describe("the keyboard after the joiner's swaps", () => {
  it("lands on the request code's copy key after asking", async () => {
    const { session } = await hosted();
    const joiner = openJoin();
    type(joiner.getByLabelText("Code"), session?.code ?? "");
    type(joiner.getByLabelText("Your name"), "Ada");
    enter(joiner.getByLabelText("Your name"));
    const copy = await joiner.findByRole("button", {
      name: "Copy your request code",
    });
    await landsOn(copy);
  });

  it("does not move a mouse user's focus when asking", async () => {
    const { session } = await hosted();
    const joiner = openJoin();
    type(joiner.getByLabelText("Code"), session?.code ?? "");
    type(joiner.getByLabelText("Your name"), "Ada");
    const close = joiner.getByRole("button", { name: "Close" });
    act(() => close.focus());
    submit(joiner.getByLabelText("Your name"));
    await joiner.findByRole("button", { name: "Copy your request code" });
    await landsOn(close);
  });

  it("lands on the joined status after Connect, so the next Tab is the first shared field", async () => {
    const { panel, session } = await hosted();
    const joiner = openJoin();
    const request = await asked(joiner, session?.code ?? "");
    type(panel.getByLabelText("A request code"), request);
    enter(panel.getByLabelText("A request code"));
    press(await panel.findByRole("button", { name: "Let Ada in" }));
    await panel.findByRole("button", { name: "Copy the reply code for Ada" });
    const reply = currentHost()?.state.guests[0]?.reply ?? "";
    const field = joiner.getByLabelText("The owner's reply code");
    type(field, reply);
    enter(field);
    await joiner.findByRole("img", { name: "Joined Team" });
    const status = joiner.getByRole("img", { name: "Joined Team" });
    await landsOn(status.closest(".live-status"));
    expect(document.body.contains(held())).toBe(true);
  });

  it("returns to the reply field, error and all, after a wrong reply", async () => {
    const { session } = await hosted();
    const joiner = openJoin();
    await asked(joiner, session?.code ?? "");
    // Opening a reply takes real time, and the field is disabled meanwhile.
    const guest = currentGuest();
    const accept = guest?.accept.bind(guest);
    if (guest && accept)
      guest.accept = async (reply) => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return accept(reply);
      };
    const field = joiner.getByLabelText("The owner's reply code");
    type(field, "osl-reply.nope.nope");
    enter(field);
    await joiner.findByRole("img", {
      name: "That reply is not for this request",
    });
    await landsOn(joiner.getByLabelText("The owner's reply code"));
  });

  it("lands on Start over when the session ends under a removed control, and on the form after it", async () => {
    // Show values draws the copy key. Copy only does not.
    const joiner = await pairedJoiner("read");
    act(() =>
      joiner.getByRole("button", { name: "Copy GitHub Password" }).focus(),
    );
    act(() => endHosting());
    await joiner.findByRole("img", { name: "The session ended" });
    const again = joiner.getByRole("button", { name: "Start over" });
    await landsOn(again);
    press(again);
    await joiner.findByLabelText("Your name");
    await landsOn(joiner.getByLabelText("Code"));
  });

  it("leaves a focus the person chose when the session ends", async () => {
    const joiner = await pairedJoiner();
    const leave = joiner.getByRole("button", { name: "Leave the session" });
    act(() => leave.focus());
    act(() => endHosting());
    await joiner.findByRole("img", { name: "The session ended" });
    await landsOn(leave);
  });

  it("returns the keyboard to the form when this browser cannot make a request", async () => {
    const { session } = await hosted();
    liveUiSeams.peers = () => {
      throw new Error("no WebRTC here");
    };
    const joiner = openJoin();
    type(joiner.getByLabelText("Code"), session?.code ?? "");
    type(joiner.getByLabelText("Your name"), "Ada");
    enter(joiner.getByLabelText("Your name"));
    await joiner.findByRole("img", {
      name: "This browser could not make a request code",
    });
    await waitFor(() => {
      const form = joiner.getByLabelText("Your name").closest("form");
      expect(form?.contains(held())).toBe(true);
    });
  });
});
