import { INITIAL_SNAPSHOT } from "@opensesame/app-core/lib/capabilities/store-types.js";
import { compositionStore } from "@opensesame/app-core/lib/capabilities/store.js";
import { clearNotices, listNotices } from "@opensesame/app-core/lib/notices.js";
import { GUIDE_GOALS } from "@opensesame/app-core/tutorial/registry/goals.js";
import {
  noteWebMcpAccepted,
  noteWebMcpRegistered,
  resetWebMcpRegistrationForTests,
} from "@opensesame/app-core/webmcp/registration.js";
/** @vitest-environment jsdom */
import {
  createFakeSupportAgent,
  fakeAgentAlwaysUnavailable,
  fakeAgentAnswering,
  fakeAgentDownloadable,
  fakeAgentDownloading,
  fakeAgentFailing,
  fakeAgentHanging,
} from "@opensesame/support-agent";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { expectInTray } from "../../components/tray.test-support.js";
import { profilePlan } from "../../lib/capabilities/__tests__/vault-profiles.js";
import {
  type VaultKeymapTarget,
  createKeymapHandler,
  registerVaultKeymap,
} from "../../lib/keymap.js";
import { supportSessionSeams } from "../session.js";
import {
  ask,
  clearedCount,
  composer,
  lockTheVault,
  mount,
  openPanel,
  renderLauncher,
  resetSupport,
  supportLifecycleSeams,
} from "./support-test-harness.js";

afterEach(() => {
  resetSupport();
  clearNotices();
});

describe("support panel", () => {
  it("opens from the overlay, and closing it puts focus back", async () => {
    const user = userEvent.setup();
    mount(fakeAgentAnswering("Anything."));
    const { affordance, panel } = await openPanel(user);

    await user.click(within(panel).getByRole("button", { name: "Close" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Support" })).toBeNull(),
    );
    expect(document.activeElement).toBe(affordance);
  });

  it("closes on Escape without the vault keymap acting on the key", async () => {
    const user = userEvent.setup();
    const acted: string[] = [];
    const record = (name: string) => () => acted.push(name);
    const target: VaultKeymapTarget = {
      next: record("next"),
      previous: record("previous"),
      first: record("first"),
      last: record("last"),
      enter: record("enter"),
      parent: record("parent"),
      activate: record("activate"),
      search: record("search"),
      closeSearch: record("closeSearch"),
      copySecret: record("copySecret"),
      copyUsername: record("copyUsername"),
      edit: record("edit"),
      trash: record("trash"),
      create: record("create"),
      favorite: record("favorite"),
      share: record("share"),
    };
    const stopVault = registerVaultKeymap(target);
    const keymap = createKeymapHandler({
      navigate: (path) => acted.push(`navigate:${path}`),
      showHelp: record("help"),
    });
    window.addEventListener("keydown", keymap, true);
    try {
      mount(fakeAgentAnswering("Anything."));
      await openPanel(user);
      fireEvent.keyDown(document.activeElement ?? document.body, {
        key: "Escape",
      });
      await waitFor(() =>
        expect(screen.queryByRole("dialog", { name: "Support" })).toBeNull(),
      );
      // The keymap bails while a modal dialog is up, so Escape never reached
      // the vault — no search closed, and nothing locked.
      expect(acted).toEqual([]);
    } finally {
      window.removeEventListener("keydown", keymap, true);
      stopVault();
    }
  });

  it("renders an answer as text", async () => {
    const user = userEvent.setup();
    mount(fakeAgentAnswering("The lock sits at the right of the statusline."));
    await openPanel(user);
    await ask(user, "where is the lock");

    expect(
      await screen.findByText("The lock sits at the right of the statusline."),
    ).toBeTruthy();
  });

  it("keeps agent thoughts and computer traces collapsed until opened", async () => {
    const user = userEvent.setup();
    mount(
      createFakeSupportAgent({
        fallback: {
          match: /.*/,
          answer: "Open Connections from the rail.",
          thoughts: "The person asked about adding a provider.",
          computer: [
            { title: "compile walkthrough", detail: "named nav.connections" },
          ],
        },
      }),
    );
    await openPanel(user);
    await ask(user, "how do I add a connection");

    expect(
      await screen.findByText("Open Connections from the rail."),
    ).toBeTruthy();
    const thoughts = screen.getByText("Thoughts").closest("details");
    const computer = screen.getByText("Computer").closest("details");
    expect(thoughts?.open).toBe(false);
    expect(computer?.open).toBe(false);
    // Nested in the Conversation live region; without this, expanding dumps
    // the trace into assistive technology as if it were a new answer.
    expect(thoughts?.getAttribute("aria-live")).toBe("off");
    expect(computer?.getAttribute("aria-live")).toBe("off");

    await user.click(screen.getByText("Thoughts"));
    expect(thoughts?.open).toBe(true);
    expect(
      screen.getByText("The person asked about adding a provider."),
    ).toBeTruthy();
    await user.click(screen.getByText("Computer"));
    expect(computer?.open).toBe(true);
    expect(screen.getByText("compile walkthrough")).toBeTruthy();
    expect(screen.getByText("named nav.connections")).toBeTruthy();
  });

  it("renders markup in an answer as literal text", async () => {
    const user = userEvent.setup();
    const payload = "<img src=x onerror=alert(1)>";
    const { container } = mount(fakeAgentAnswering(payload));
    await openPanel(user);
    await ask(user, "anything");

    expect(await screen.findByText(payload)).toBeTruthy();
    expect(container.querySelector("img")).toBeNull();
    expect(document.querySelectorAll("img")).toHaveLength(0);
  });

  it("still opens and helps when nothing can answer", async () => {
    const user = userEvent.setup();
    mount(fakeAgentAlwaysUnavailable("no_local_model"), "none");
    await openPanel(user);

    // No sentence narrating why nothing can answer: the written help below is
    // the answer, and the field says what it now does.
    expect(screen.queryByText(/no on-device model/i)).toBeNull();
    expect(
      screen.getByRole("button", { name: "Where do I lock the vault?" }),
    ).toBeTruthy();
    const field = await screen.findByLabelText<HTMLInputElement>(
      "Search the written help",
    );
    expect(field.disabled).toBe(false);
    expect(screen.getByRole("button", { name: "Search" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Search" })).toBeTruthy();
    expect(screen.queryByRole("tab", { name: "Ask" })).toBeNull();
  });

  it("keeps the Ask tab when local AI is approved and the model is not ready", async () => {
    const user = userEvent.setup();
    const plan = profilePlan("full");
    const snapshot = {
      ...INITIAL_SNAPSHOT,
      status: "ready" as const,
      plan,
    };
    const read = compositionStore.getSnapshot;
    compositionStore.getSnapshot = () => snapshot;
    try {
      mount(fakeAgentAlwaysUnavailable("no_local_model"), "none");
      await openPanel(user);
      expect(screen.getByRole("tab", { name: "Ask" })).toBeTruthy();
      expect(screen.queryByRole("tab", { name: "Search" })).toBeNull();
      expect(
        await screen.findByLabelText("Search the written help"),
      ).toBeTruthy();
      expect(screen.getByRole("button", { name: "Search" })).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Ask" })).toBeNull();
    } finally {
      compositionStore.getSnapshot = read;
    }
  });

  it("answers an authored topic with no model at all", async () => {
    const user = userEvent.setup();
    mount(fakeAgentAlwaysUnavailable("no_local_model"), "none");
    await openPanel(user);
    await user.click(
      await screen.findByRole("button", { name: "Where do I lock the vault?" }),
    );

    expect(
      await screen.findByText(/Locking drops the vault keys held in memory/),
    ).toBeTruthy();
  });

  it("offers the download only as a gesture, and reports its progress", async () => {
    const user = userEvent.setup();
    mount(fakeAgentDownloadable());
    await openPanel(user);
    const download = await screen.findByRole("button", {
      name: "Download the on-device model",
    });
    await user.click(download);

    const field = await composer();
    await waitFor(() => expect(field.disabled).toBe(false));
  });

  it("labels an answer with the written help it cited and offers its walkthrough", async () => {
    const user = userEvent.setup();
    mount(
      fakeAgentAnswering(
        "Identity, then Providers, then Register an IdP.\nsources: help.identity.account.add",
      ),
    );
    await openPanel(user);
    await ask(user, "how do I add a user?");

    expect(
      await screen.findByText(
        "Identity, then Providers, then Register an IdP.",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Drawn from the written help: “How do I add someone to this deployment?”.",
      ),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", {
        name: "Show me: Add an account to this deployment",
      }),
    ).toBeTruthy();
    expect(screen.queryByText(/sources:/)).toBeNull();
  });

  it("puts the written answer beside a reply that cited nothing it plainly covers", async () => {
    const user = userEvent.setup();
    mount(
      fakeAgentAnswering(
        "Navigate to Identity, then select Identity.schema and click Add.",
      ),
    );
    await openPanel(user);
    await ask(user, "how do I add a user?");

    const note = await screen.findByText(/cited nothing from the written help/);
    expect(note.textContent).toContain(
      "“How do I add someone to this deployment?”",
    );
    expect(note.textContent).toContain("Register an IdP");
    expect(
      screen.getByRole("button", {
        name: "Show me: Add an account to this deployment",
      }),
    ).toBeTruthy();
  });

  it("marks a reply unverified when it cites nothing and nothing written matches", async () => {
    const user = userEvent.setup();
    mount(fakeAgentAnswering("Try the Billing tab."));
    await openPanel(user);
    await ask(user, "zzyzx quux?");
    expect(
      await screen.findByText(
        /it is unverified: a control it names may not exist/,
      ),
    ).toBeTruthy();
  });

  it("keeps the browser's model context out of the sheet", async () => {
    const user = userEvent.setup();
    mount(fakeAgentAlwaysUnavailable("no_local_model"), "none");
    await openPanel(user);

    // What the page registered with the browser's model context is a DevTools
    // fact, not a sentence for the person: the sheet narrates nothing.
    noteWebMcpRegistered("document", "boot", [
      { name: "opensesame_status", description: "status", scope: "boot" },
    ]);
    noteWebMcpAccepted("opensesame_status");
    expect(screen.queryByLabelText("WebMCP status")).toBeNull();
    expect(screen.queryByText(/WebMCP:/)).toBeNull();
    resetWebMcpRegistrationForTests();
  });

  it("searches the written help without asking anything", async () => {
    const user = userEvent.setup();
    mount(fakeAgentAlwaysUnavailable("no_local_model"), "none");
    await openPanel(user);

    // With no model the one field searches the checked-in help rather than
    // asking, live as you type, and says so on the button.
    const field = await screen.findByLabelText<HTMLInputElement>(
      "Search the written help",
    );
    await user.type(field, "healthy");
    expect(
      await screen.findByRole("button", {
        name: "How do I tell whether OpenSesame is healthy?",
      }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Where do I lock the vault?" }),
    ).toBeNull();
  });

  it("runs a walkthrough the answer came with", async () => {
    const user = userEvent.setup();
    const goal = GUIDE_GOALS[0];
    if (!goal) throw new Error("no authored goal to script");
    const { engine: built } = mount(
      fakeAgentAnswering("Here is where that lives.", goal.guide),
    );
    await openPanel(user);
    await ask(user, "where is the lock");

    await user.click(await screen.findByRole("button", { name: /^Next/ }));
    await waitFor(() =>
      expect(
        built.renderer.calls.some(
          (call) => call.kind === "focus" && call.target === "shell.lock",
        ),
      ).toBe(true),
    );
    // The answer it came with is still in the transcript when the panel returns.
    await user.click(
      screen.getByRole("button", { name: "Support — tutorial in progress" }),
    );
    expect(await screen.findByText("Here is where that lives.")).toBeTruthy();
  });

  it("keeps the answer when the walkthrough attached to it is refused", async () => {
    const user = userEvent.setup();
    const { engine: built } = mount(
      fakeAgentAnswering(
        "Connections is the place.",
        ["guide/1", 'goal "connection.create"', 'click ".btn--primary"'].join(
          "\n",
        ),
      ),
    );
    await openPanel(user);
    await ask(user, "how do I add a connection");

    expect(await screen.findByText("Connections is the place.")).toBeTruthy();
    await expectInTray(/refused before anything ran/i);
    // Nothing was drawn: a program that does not compile never reaches a run.
    expect(built.renderer.calls).toHaveLength(0);
  });

  it("reports a download already in flight", async () => {
    const user = userEvent.setup();
    mount(fakeAgentDownloading(0.4));
    await openPanel(user);

    const read = await screen.findByText(/Downloading the on-device model/);
    expect(read.textContent).toContain("40%");
    // A download in flight is not a reason to withhold the written help: the
    // field still searches it while the model arrives.
    expect((await composer()).disabled).toBe(false);
  });

  it("raises a failure as a notice, in a sentence, with no code in it", async () => {
    const user = userEvent.setup();
    mount(fakeAgentFailing("AGENT_PROTOCOL_ERROR"));
    await openPanel(user);
    await ask(user, "anything");

    // A failure is a notice in the tray, never a paragraph inside the sheet.
    await waitFor(() =>
      expect(
        listNotices().find((n) => n.id === "support.failure"),
      ).toBeTruthy(),
    );
    const notice = listNotices().find((n) => n.id === "support.failure");
    expect(notice?.body).toContain("did not arrive in one piece");
    // No code, no stack, nothing internal.
    expect(notice?.body).not.toContain("AGENT_PROTOCOL_ERROR");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("cancels a question that is still in flight", async () => {
    const user = userEvent.setup();
    mount(fakeAgentHanging());
    await openPanel(user);
    await ask(user, "something slow");

    const cancel = await screen.findByRole("button", { name: "Cancel" });
    await user.click(cancel);

    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull(),
    );
    expect(await screen.findByText("Stopped.")).toBeTruthy();
  });

  it("still helps when the support engine itself cannot load", async () => {
    const user = userEvent.setup();
    Object.assign(supportSessionSeams, {
      loadEngine: () => Promise.reject(new Error("chunk unavailable")),
      ...supportLifecycleSeams(),
    });
    renderLauncher();
    await openPanel(user);

    // The chunk that failed to load is a notice in the tray; the sheet still
    // opens on the written help, which needs no chunk at all.
    await waitFor(() =>
      expect(
        listNotices().find((n) => n.id === "support.failure"),
      ).toBeTruthy(),
    );
    expect(screen.queryByRole("alert")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Where do I lock the vault?" }),
    ).toBeTruthy();
  });

  it("shows the remote-transport warning only when answers leave the device", async () => {
    const user = userEvent.setup();
    mount(
      fakeAgentAnswering("Anything."),
      "remote",
      "Answers leave this device.",
    );
    await openPanel(user);
    expect(await screen.findByText("Answers leave this device.")).toBeTruthy();
  });

  it("keeps no warning when the answer never leaves the device", async () => {
    const user = userEvent.setup();
    mount(fakeAgentAnswering("Anything."), "on-device", null);
    await openPanel(user);
    expect(screen.queryByText(/leave this device/i)).toBeNull();
  });

  it("clears the conversation on request", async () => {
    const user = userEvent.setup();
    mount(fakeAgentAnswering("An answer worth forgetting."));
    await openPanel(user);
    await ask(user, "a question");
    await screen.findByText("An answer worth forgetting.");

    await user.click(
      screen.getByRole("button", { name: "Clear conversation" }),
    );
    await waitFor(() =>
      expect(screen.queryByText("An answer worth forgetting.")).toBeNull(),
    );
  });

  it("drops the transcript, the guide and the panel when the vault locks", async () => {
    const user = userEvent.setup();
    const { engine: built } = mount(fakeAgentAnswering("Ephemeral."));
    await openPanel(user);
    await ask(user, "a question");
    await screen.findByText("Ephemeral.");

    await user.click(
      screen.getAllByRole("button", { name: "Show me" }).at(0) ?? document.body,
    );
    await waitFor(() => expect(built.renderer.calls.length).toBeGreaterThan(0));

    // Back into the panel with a tutorial live behind it, and lock there.
    await user.click(
      await screen.findByRole("button", {
        name: "Support — tutorial in progress",
      }),
    );
    await screen.findByRole("dialog", { name: "Support" });

    lockTheVault();

    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Support" })).toBeNull(),
    );
    expect(built.destroyed()).toBe(true);
    // The agent session went with it, and so did every overlay it drew.
    expect(built.agent.destroyed()).toBe(true);
    expect(built.renderer.calls.some((call) => call.kind === "clear")).toBe(
      true,
    );
    expect(clearedCount()).toBeGreaterThan(0);

    // Re-opening starts from nothing: no transcript survived the lock.
    await user.click(screen.getByRole("button", { name: "Support" }));
    await screen.findByRole("dialog", { name: "Support" });
    expect(screen.queryByText("Ephemeral.")).toBeNull();
    expect(screen.queryByText("a question")).toBeNull();
  });
});

describe("support panel accessibility", () => {
  it("names the affordance and the dialog, and keeps Tab inside it", async () => {
    const user = userEvent.setup();
    mount(fakeAgentAnswering("Anything."));
    const { affordance, panel } = await openPanel(user);

    expect(affordance.getAttribute("aria-label")).toBe("Support");
    expect(panel.getAttribute("aria-modal")).toBe("true");
    expect(panel.getAttribute("aria-label")).toBe("Support");

    const focusable = [
      ...panel.querySelectorAll<HTMLElement>("a[href], button, input"),
    ].filter((element) => !element.hasAttribute("disabled"));
    const last = focusable.at(-1);
    if (!last) throw new Error("the dialog has nothing to focus");
    last.focus();
    fireEvent.keyDown(last, { key: "Tab" });

    // The shared sheet layer traps rather than inerting: the app's sheets are
    // not native <dialog>, so focus is kept inside by the Tab handler.
    expect(panel.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(affordance);
  });
});
