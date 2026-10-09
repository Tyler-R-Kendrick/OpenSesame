/** @vitest-environment jsdom */
/**
 * Shared setup for LiveFocus keyboard tests (split to stay under the size budget).
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
import { afterEach, beforeEach, expect, vi } from "vitest";
import { vaultHooksSeams } from "../../lib/vault/hooks.js";
import { withPassword } from "../../sections/vault/account.test-support.js";
import { LiveHostPanel } from "./LiveHostPanel.js";
import { LiveJoinRoute } from "./LiveJoinRoute.js";
import { clearJoinDraft, liveUiSeams } from "./live-hooks.js";
import { transportSeams } from "./live-transport-hooks.js";

export const github = createItem("account", "GitHub");
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

export function installLiveFocusTests(): void {
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
}

export function press(element: HTMLElement) {
  act(() => element.focus());
  fireEvent.click(element);
}

export function submit(field: HTMLElement) {
  const form = field.closest("form");
  if (!form) throw new Error("a field with no form");
  fireEvent.submit(form);
}

export function enter(field: HTMLElement) {
  act(() => field.focus());
  submit(field);
}

export function type(field: HTMLElement, value: string) {
  fireEvent.change(field, { target: { value } });
}

export const held = () => document.activeElement;

export async function landsOn(element: Element | null | undefined) {
  await waitFor(() => expect(held()).toBe(element));
}

export async function host(
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

export function openJoin() {
  const { container } = render(
    <MemoryRouter>
      <LiveJoinRoute />
    </MemoryRouter>,
  );
  return within(container);
}

export async function hosted(values: "read" | "use" | "edit" = "use") {
  const panel = await host("invite", values);
  press(panel.getByRole("button", { name: "Start the live session" }));
  await panel.findByRole("img", { name: "Live" });
  const session = currentHost();
  holdLiveLink(session?.link ?? null);
  return { panel, session };
}

export async function asked(joiner: ReturnType<typeof within>, code: string) {
  type(joiner.getByLabelText("Code"), code);
  type(joiner.getByLabelText("Your name"), "Ada");
  enter(joiner.getByLabelText("Your name"));
  await joiner.findByRole("button", { name: "Copy your request code" });
  const status = currentGuest()?.status;
  return status?.at === "request" ? status.code : "";
}

export async function pairedJoiner(values: "read" | "use" | "edit" = "use") {
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
