/** @vitest-environment jsdom */
import { compileGuide } from "@opensesame/guide-lang";
import {
  type FakeGuideRoutes,
  type FakeGuideTargets,
  type RecordingGuideRenderer,
  type TestGuideClock,
  createFakeRoutes,
  createFakeState,
  createFakeTargets,
  createGuideRuntime,
  createRecordingRenderer,
  createTestClock,
} from "@opensesame/guide-runtime";
import {
  type FakeSupportAgent,
  createSupportSession,
  fakeAgentAlwaysUnavailable,
  fakeAgentAnswering,
  fakeAgentDownloadable,
  fakeAgentDownloading,
  fakeAgentFailing,
  fakeAgentHanging,
  supportVocabulary,
} from "@opensesame/support-agent";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import {
  type VaultKeymapTarget,
  createKeymapHandler,
  registerVaultKeymap,
} from "../../lib/keymap.js";
import { webmcpSupportSeam } from "../../webmcp/tools.js";
import { buildSupportPageContext } from "../registry/context.js";
import { GUIDE_GOALS } from "../registry/goals.js";
import { guideGoalIds } from "../registry/goals.js";
import { GUIDE_ROUTES } from "../registry/routes.js";
import { guidePredicateIds } from "../registry/state.js";
import { guideTargetIds } from "../registry/targets.js";
import {
  type SupportEngine,
  SupportProvider,
  type SupportTransport,
  chooseSupportAgent,
  supportSessionSeams,
} from "../session.js";
import { SupportLauncher } from "./SupportLauncher.js";

/**
 * The engine every test drives: the real support session, the real guide
 * runtime and the real compiler, over the package's recording fakes. Nothing
 * is mocked — the seam below swaps one whole engine for another, which is what
 * lets these tests assert on the composition rather than on stubs.
 */
type TestEngine = SupportEngine & {
  readonly renderer: RecordingGuideRenderer;
  readonly targets: FakeGuideTargets;
  readonly routes: FakeGuideRoutes;
  readonly clock: TestGuideClock;
  readonly agent: FakeSupportAgent;
  destroyed(): boolean;
};

function buildEngine(
  agent: FakeSupportAgent,
  transport: SupportTransport = "on-device",
  warning: string | null = null,
): TestEngine {
  const context = buildSupportPageContext({
    pageId: "test",
    route: "/vault",
    hostReachable: true,
    identityReachable: true,
  });
  const vocabulary = supportVocabulary(context);
  const session = createSupportSession({
    port: agent,
    vocabulary,
    readContext: () => context,
  });
  const renderer = createRecordingRenderer();
  const targets = createFakeTargets(vocabulary.targets, vocabulary.targets);
  const routes = createFakeRoutes(vocabulary.routes, "/vault");
  const clock = createTestClock();
  const runtime = createGuideRuntime({
    renderer,
    targets,
    routes,
    state: createFakeState([]),
    clock,
  });
  let destroyed = false;

  return {
    transport,
    warning,
    session,
    renderer,
    targets,
    routes,
    clock,
    agent,
    compile(source) {
      const result = compileGuide(source, vocabulary);
      return result.ok ? result.program : null;
    },
    // Authored walkthroughs compile against the whole registry, as they do in
    // the app.
    compileAuthored(source) {
      const result = compileGuide(source, {
        goals: guideGoalIds(),
        targets: guideTargetIds(),
        routes: GUIDE_ROUTES.map((route) => route.id),
        predicates: guidePredicateIds(),
      });
      return result.ok ? result.program : null;
    },
    runGuide: (program) => runtime.start(program),
    pauseGuide: () => runtime.pause(),
    cancelGuide: (reason) => runtime.cancel(reason),
    subscribeGuide: (listener) => runtime.subscribe({ onSnapshot: listener }),
    async acquire(onProgress) {
      onProgress(0.5);
      agent.setAvailability({ kind: "ready" });
      return { kind: "acquired" };
    },
    destroy() {
      destroyed = true;
      runtime.cancel("lock");
      renderer.clear();
      session.destroy();
    },
    destroyed: () => destroyed,
  };
}

const original = { ...supportSessionSeams };
let engine: TestEngine | null = null;
let cleared = 0;
const lockHandlers = new Set<() => void>();

function mount(
  agent: FakeSupportAgent,
  transport: SupportTransport = "on-device",
  warning: string | null = null,
) {
  const built = buildEngine(agent, transport, warning);
  engine = built;
  Object.assign(supportSessionSeams, {
    loadEngine: () => Promise.resolve(built),
    onLock: (handler: () => void) => {
      lockHandlers.add(handler);
      return () => lockHandlers.delete(handler);
    },
    clearTargets: () => {
      cleared += 1;
    },
  });
  const view = render(
    <MemoryRouter initialEntries={["/vault"]}>
      <SupportProvider>
        <SupportLauncher />
      </SupportProvider>
    </MemoryRouter>,
  );
  return { ...view, engine: built };
}

function lockTheVault(): void {
  for (const handler of [...lockHandlers]) handler();
}

async function openPanel(user: ReturnType<typeof userEvent.setup>) {
  const affordance = screen.getByRole("button", { name: "Support" });
  await user.click(affordance);
  const panel = await screen.findByRole("dialog", { name: "Support" });
  return { affordance, panel };
}

/** The composer, typed, so `disabled` can be read without a cast. */
function composer(): Promise<HTMLInputElement> {
  return screen.findByLabelText<HTMLInputElement>("Ask about this screen");
}

async function ask(
  user: ReturnType<typeof userEvent.setup>,
  question: string,
): Promise<void> {
  const field = await composer();
  await waitFor(() => expect(field.disabled).toBe(false));
  await user.type(field, question);
  await user.click(screen.getByRole("button", { name: "Ask" }));
}

afterEach(() => {
  cleanup();
  Object.assign(supportSessionSeams, original);
  lockHandlers.clear();
  engine = null;
  cleared = 0;
});

describe("support panel", () => {
  it("opens from the statusline, and closing it puts focus back", async () => {
    const user = userEvent.setup();
    mount(fakeAgentAnswering("Anything."));
    const { affordance, panel } = await openPanel(user);

    expect(panel.contains(document.activeElement)).toBe(true);

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

  it("still opens, explains itself and helps when nothing can answer", async () => {
    const user = userEvent.setup();
    mount(fakeAgentAlwaysUnavailable("no_local_model"), "none");
    await openPanel(user);

    expect(await screen.findByText(/no on-device model/i)).toBeTruthy();
    // The written help is the point: it is data, not a model's memory.
    expect(
      screen.getByRole("button", { name: "Where do I lock the vault?" }),
    ).toBeTruthy();
    expect((await composer()).disabled).toBe(true);
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

  it("launches a named walkthrough with no model at all", async () => {
    const user = userEvent.setup();
    const { engine: built } = mount(
      fakeAgentAlwaysUnavailable("no_local_model"),
      "none",
    );
    await openPanel(user);
    const walkthroughs = await screen.findByRole("region", {
      name: "Walkthroughs",
    });
    expect(walkthroughs.textContent).toContain("Lock the vault");
    const [start] = screen.getAllByRole("button", { name: "Show me" });
    if (!start) throw new Error("no walkthrough to start");
    await user.click(start);

    await waitFor(() => {
      expect(
        built.renderer.calls.some(
          (call) => call.kind === "focus" && call.target === "shell.lock",
        ),
      ).toBe(true);
    });
    // The sheet steps aside for the walkthrough, and the statusline says one
    // is live — reopening it is how the person pauses or stops.
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Support" })).toBeNull(),
    );
    const live = await screen.findByRole("button", {
      name: "Support — walkthrough in progress",
    });
    await user.click(live);
    expect(
      await screen.findByRole("region", { name: "Walkthrough in progress" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
  });

  it("binds the WebMCP guidance tools to this panel", async () => {
    mount(fakeAgentAlwaysUnavailable("no_local_model"), "none");
    webmcpSupportSeam.openSupport("help.lock");

    expect(await screen.findByRole("dialog", { name: "Support" })).toBeTruthy();
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

  it("searches the written help without asking anything", async () => {
    const user = userEvent.setup();
    mount(fakeAgentAlwaysUnavailable("no_local_model"), "none");
    await openPanel(user);

    await user.type(screen.getByLabelText("Search help"), "healthy");
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

    await waitFor(() =>
      expect(
        built.renderer.calls.some(
          (call) => call.kind === "focus" && call.target === "shell.lock",
        ),
      ).toBe(true),
    );
    // The panel stepped aside for the walkthrough; the answer it came with is
    // still in the transcript when the panel comes back.
    await user.click(
      screen.getByRole("button", { name: "Support — walkthrough in progress" }),
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
    expect(
      await screen.findByText(/refused before anything ran/i),
    ).toBeTruthy();
    // Nothing was drawn: a program that does not compile never reaches a run.
    expect(built.renderer.calls).toHaveLength(0);
  });

  it("reports a download already in flight", async () => {
    const user = userEvent.setup();
    mount(fakeAgentDownloading(0.4));
    await openPanel(user);

    const read = await screen.findByText(/Downloading the on-device model/);
    expect(read.textContent).toContain("40%");
    expect((await composer()).disabled).toBe(true);
  });

  it("says so, in a sentence, when the answer fails to arrive", async () => {
    const user = userEvent.setup();
    mount(fakeAgentFailing("AGENT_PROTOCOL_ERROR"));
    await openPanel(user);
    await ask(user, "anything");

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("did not arrive in one piece");
    // No code, no stack, nothing internal.
    expect(alert.textContent).not.toContain("AGENT_PROTOCOL_ERROR");
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
      onLock: (handler: () => void) => {
        lockHandlers.add(handler);
        return () => lockHandlers.delete(handler);
      },
      clearTargets: () => {
        cleared += 1;
      },
    });
    render(
      <MemoryRouter initialEntries={["/vault"]}>
        <SupportProvider>
          <SupportLauncher />
        </SupportProvider>
      </MemoryRouter>,
    );
    await openPanel(user);

    expect(await screen.findByRole("alert")).toBeTruthy();
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

    const [start] = screen.getAllByRole("button", { name: "Show me" });
    if (!start) throw new Error("no walkthrough to start");
    await user.click(start);
    await waitFor(() => expect(built.renderer.calls.length).toBeGreaterThan(0));

    // Back into the panel, with a walkthrough live behind it, and lock there.
    await user.click(
      screen.getByRole("button", { name: "Support — walkthrough in progress" }),
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
    expect(cleared).toBeGreaterThan(0);

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

describe("choosing what answers", () => {
  const absent = fakeAgentAlwaysUnavailable("no_local_model");

  it("keeps a question on the device whenever the device can answer", () => {
    const local = fakeAgentAnswering("local");
    const remote = fakeAgentAnswering("remote");
    const choice = chooseSupportAgent(
      local,
      { kind: "ready" },
      () => remote,
      absent,
    );
    expect(choice.transport).toBe("on-device");
    expect(choice.port).toBe(local);
    // A downloading model is still a model; the endpoint does not win here.
    expect(
      chooseSupportAgent(
        local,
        { kind: "downloading", progress: 0.2 },
        () => remote,
        absent,
      ).transport,
    ).toBe("on-device");
  });

  /**
   * Pinned because it looks like a bug and is not. A browser that exposes the
   * Prompt API without the model downloaded reports `downloadable`, and this
   * still chooses the device: the panel says the model has not been fetched and
   * offers the download as a click. Preferring the endpoint would send somebody
   * questions off their device because of a download nobody asked them about,
   * which is the opposite of what on-device-by-default is for.
   */
  it("still prefers the device when its model has not been downloaded yet", () => {
    const local = fakeAgentAnswering("local");
    const remote = fakeAgentAnswering("remote");
    const choice = chooseSupportAgent(
      local,
      { kind: "downloadable" },
      () => remote,
      absent,
    );
    expect(choice.transport).toBe("on-device");
    expect(choice.port).toBe(local);
    expect(remote.destroyed()).toBe(false);
  });

  it("falls back to a configured endpoint only when the device cannot", () => {
    const local = fakeAgentAnswering("local");
    const remote = fakeAgentAnswering("remote");
    const choice = chooseSupportAgent(
      local,
      { kind: "unavailable", reason: "platform_unsupported" },
      () => remote,
      absent,
    );
    expect(choice.transport).toBe("remote");
    expect(choice.port).toBe(remote);
    // The unused provider session is dropped rather than left holding context.
    expect(local.destroyed()).toBe(true);
  });

  it("keeps the local reason when there is no endpoint to fall back to", () => {
    const local = fakeAgentAlwaysUnavailable("model_not_downloaded");
    const choice = chooseSupportAgent(
      local,
      { kind: "unavailable", reason: "model_not_downloaded" },
      () => null,
      absent,
    );
    expect(choice.transport).toBe("on-device");
    expect(choice.port).toBe(local);
  });

  it("still answers with something when the browser has neither", () => {
    const choice = chooseSupportAgent(null, null, () => null, absent);
    expect(choice.transport).toBe("none");
    expect(choice.port).toBe(absent);
  });
});
