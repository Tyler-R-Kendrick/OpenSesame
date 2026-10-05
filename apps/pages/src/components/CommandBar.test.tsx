import { readCommand } from "@opensesame/app-core/lib/command-bar/parse.js";
import { registerContributionForTest } from "@opensesame/app-core/lib/contributions.js";
import { buildSupportPageContext } from "@opensesame/app-core/tutorial/registry/context.js";
/** @vitest-environment jsdom */
import {
  type FakeSupportAgent,
  createSupportSession,
  fakeAgentAlwaysUnavailable,
  fakeAgentAnswering,
  supportVocabulary,
} from "@opensesame/support-agent";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Link, MemoryRouter, useLocation } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  liveSearch,
  registerSearchConsumer,
} from "../lib/command-bar/search.js";
import { vaultHooksSeams } from "../lib/vault/hooks.js";
import {
  type SupportEngine,
  SupportProvider,
  supportSessionSeams,
} from "../tutorial/session.js";
import {
  SupportLauncher,
  SupportSlotProvider,
} from "../tutorial/ui/SupportLauncher.js";
import { CommandBar } from "./CommandBar.js";

const originalVaultHooks = { ...vaultHooksSeams };
const originalSessionSeams = { ...supportSessionSeams };
let releaseAssist: (() => void) | null = null;

/** The ask road exists only while a model capability has registered. */
function enableAsk(): void {
  releaseAssist = registerContributionForTest("command-assist", {
    id: "test-model",
    order: 0,
    interpret: async (text) => readCommand(text),
  });
}

Object.assign(vaultHooksSeams, {
  useVault: () => ({ items: [], status: "unlocked" }),
  useCopySecret: () => async () => ({ ok: true as const, clearsInMs: 0 }),
});

/** The smallest engine that answers: no walkthrough runtime, one fake agent. */
function installEngine(agent: FakeSupportAgent): void {
  const context = buildSupportPageContext({
    pageId: "command-bar",
    route: "/vault",
    hostReachable: false,
    identityReachable: false,
  });
  const session = createSupportSession({
    port: agent,
    vocabulary: supportVocabulary(context),
    readContext: () => context,
  });
  const engine: SupportEngine = {
    transport: "on-device",
    warning: null,
    session,
    compile: () => null,
    compileAuthored: () => null,
    runGuide: async () => ({ kind: "cancelled", goal: "none", reason: "user" }),
    nextStep() {},
    backStep() {},
    restartGuide() {},
    pauseGuide() {},
    cancelGuide() {},
    subscribeGuide: () => () => {},
    async acquire() {
      return { kind: "acquired" };
    },
    destroy() {
      session.destroy();
    },
  };
  Object.assign(supportSessionSeams, {
    loadEngine: () => Promise.resolve(engine),
    onLock: () => () => {},
    clearTargets: () => {},
  });
}

function renderBar(withSupport: boolean) {
  const bar = <CommandBar />;
  return render(
    <MemoryRouter initialEntries={["/vault"]}>
      {withSupport ? (
        <SupportProvider>
          <SupportSlotProvider>
            {bar}
            <SupportLauncher />
          </SupportSlotProvider>
        </SupportProvider>
      ) : (
        bar
      )}
    </MemoryRouter>,
  );
}

/** The bar beside the address it navigates, and a way out of the section. */
function Where() {
  const { pathname, search } = useLocation();
  return <output data-testid="where">{`${pathname}${search}`}</output>;
}

function renderBarAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <CommandBar />
      <Where />
      <Link to="/settings">elsewhere</Link>
    </MemoryRouter>,
  );
}

afterEach(() => {
  releaseAssist?.();
  releaseAssist = null;
  cleanup();
  Object.assign(vaultHooksSeams, originalVaultHooks);
  Object.assign(supportSessionSeams, originalSessionSeams);
});

describe("CommandBar — command or ask", () => {
  it("parses commands and does not ask while no model is on", async () => {
    installEngine(fakeAgentAnswering("Connections live under the rail."));
    const user = userEvent.setup();
    renderBar(true);
    const field = screen.getByRole("combobox", { name: "Command" });
    expect(field.getAttribute("placeholder")).toBe(
      "go to vault · search · copy password for …",
    );
    await user.type(field, "where are my connections?{Enter}");
    expect((await screen.findByRole("status")).textContent).toContain(
      "No match",
    );
    expect(screen.queryByRole("dialog", { name: "Support" })).toBeNull();
    await user.clear(field);
    await user.type(field, "go to vault{Enter}");
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain("Opened /vault"),
    );
    await user.type(field, "search router{Enter}");
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain(
        "Searching for “router”",
      ),
    );
  });

  it("hands a sentence no verb claims to Support as a question", async () => {
    enableAsk();
    installEngine(fakeAgentAnswering("Connections live under the rail."));
    const user = userEvent.setup();
    renderBar(true);
    const field = screen.getByRole("combobox", { name: "Command" });
    await user.type(field, "where are my connections?{Enter}");
    const sheet = await screen.findByRole("dialog", { name: "Support" });
    // The question lands in the transcript, the field is spent, and the bar
    // does not also print a "no match" beside an answer that is on its way.
    await waitFor(() =>
      expect(sheet.textContent).toContain("where are my connections?"),
    );
    expect(sheet.textContent).toContain("Connections live under the rail.");
    expect(field).toHaveProperty("value", "");
    expect(screen.queryByText(/No match/)).toBeNull();
  });

  it("keeps the honest no-match where Support cannot answer", async () => {
    enableAsk();
    installEngine(fakeAgentAlwaysUnavailable());
    const user = userEvent.setup();
    renderBar(true);
    const field = screen.getByRole("combobox", { name: "Command" });
    // Support reports its absence once opened; a closed sheet has not yet.
    await user.click(screen.getByRole("button", { name: "Support" }));
    await screen.findByRole("dialog", { name: "Support" });
    await user.keyboard("{Escape}");
    await user.type(field, "where are my connections?{Enter}");
    expect(await screen.findByRole("status")).toHaveProperty(
      "textContent",
      expect.stringContaining("No match"),
    );
  });

  it("searches in the field: the words stay, nothing opens over it, Esc empties it", async () => {
    const user = userEvent.setup();
    renderBar(false);
    const field = screen.getByRole("combobox", {
      name: "Command",
    }) as HTMLInputElement;
    await user.type(field, "/? bank");
    expect(liveSearch()).toBe("bank");
    await user.keyboard("{Enter}");
    // Enter commits; it never empties the field or opens a notice over it.
    expect(field.value).toBe("/? bank");
    expect(screen.queryByRole("status")).toBeNull();
    expect(liveSearch()).toBe("bank");
    await user.click(field);
    await user.keyboard("{Escape}");
    expect(field.value).toBe("");
    expect(liveSearch()).toBeNull();
  });

  it("Enter hands the words to the listing on screen, or brings up the vault's list", async () => {
    const user = userEvent.setup();
    const focus = vi.fn(() => true);
    const stop = registerSearchConsumer({ visible: () => true, focus });
    renderBarAt("/start");
    const field = screen.getByRole("combobox", { name: "Command" });
    await user.type(field, "/? bank{Enter}");
    expect(focus).toHaveBeenCalledOnce();
    expect(screen.getByTestId("where").textContent).toBe("/start");
    stop();
    // With nothing searching on screen the words open the list that will.
    await user.clear(field);
    await user.type(field, "/? bank{Enter}");
    expect(screen.getByTestId("where").textContent).toBe("/vault?f=all");
    expect((field as HTMLInputElement).value).toBe("/? bank");
  });

  it("a listing with nothing to land on leaves the caret in the field", async () => {
    const user = userEvent.setup();
    // An empty result: the listing is on screen but takes no focus.
    const stop = registerSearchConsumer({
      visible: () => true,
      focus: () => false,
    });
    renderBarAt("/start");
    const field = screen.getByRole("combobox", { name: "Command" });
    await user.type(field, "/? zzzz{Enter}");
    expect(document.activeElement).toBe(field);
    expect(screen.getByTestId("where").textContent).toBe("/start");
    expect((field as HTMLInputElement).value).toBe("/? zzzz");
    stop();
  });

  it("a commit that stays in its section does not carry the words into the next", async () => {
    const user = userEvent.setup();
    renderBarAt("/vault");
    const field = screen.getByRole("combobox", {
      name: "Command",
    }) as HTMLInputElement;
    await user.type(field, "/? bank{Enter}");
    expect(screen.getByTestId("where").textContent).toBe("/vault?f=all");
    await user.click(screen.getByRole("link", { name: "elsewhere" }));
    expect(field.value).toBe("");
    expect(liveSearch()).toBeNull();
  });

  it("Escape during an IME composition cancels the composition, not the search", async () => {
    const user = userEvent.setup();
    renderBarAt("/vault");
    const field = screen.getByRole("combobox", {
      name: "Command",
    }) as HTMLInputElement;
    await user.type(field, "/? ba");
    fireEvent.keyDown(field, { key: "Escape", isComposing: true });
    expect(field.value).toBe("/? ba");
    expect(liveSearch()).toBe("ba");
    fireEvent.keyDown(field, { key: "Escape" });
    expect(field.value).toBe("");
  });

  it("Run is not offered for a search with no words yet", async () => {
    const user = userEvent.setup();
    renderBarAt("/vault");
    const run = screen.getByRole("button", { name: "Run command" });
    await user.type(screen.getByRole("combobox", { name: "Command" }), "/? ");
    expect((run as HTMLButtonElement).disabled).toBe(true);
    await user.keyboard("a");
    expect((run as HTMLButtonElement).disabled).toBe(false);
  });

  it("words typed for one section do not follow a person into another", async () => {
    const user = userEvent.setup();
    renderBarAt("/vault");
    const field = screen.getByRole("combobox", {
      name: "Command",
    }) as HTMLInputElement;
    await user.type(field, "/? bank");
    await user.click(screen.getByRole("link", { name: "elsewhere" }));
    expect(field.value).toBe("");
    expect(liveSearch()).toBeNull();
  });

  it("a bare /? is still help, and is not a search", async () => {
    const user = userEvent.setup();
    renderBar(false);
    const field = screen.getByRole("combobox", { name: "Command" });
    await user.type(field, "/?");
    expect(liveSearch()).toBeNull();
  });

  it("completes slash commands and item names from the status field", async () => {
    Object.assign(vaultHooksSeams, {
      useVault: () => ({
        items: [{ name: "GitHub", password: "s3cret-value", deletedAt: null }],
        status: "unlocked",
      }),
    });
    const user = userEvent.setup();
    renderBar(false);
    const field = screen.getByRole("combobox", { name: "Command" });
    await user.type(field, "/");
    const list = await screen.findByRole("listbox", { name: "Commands" });
    expect(list.textContent).toContain("/vault");
    expect(list.textContent).not.toContain("s3cret-value");
    await user.keyboard("{Enter}");
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain("Opened /vault"),
    );
    // Search has no list of names to pick: the listing narrows as it is typed.
    await user.type(field, "/? gi");
    expect(screen.queryByRole("listbox", { name: "Commands" })).toBeNull();
    expect(liveSearch()).toBe("gi");
  });

  it("still runs commands, and still shrugs, with no Support mounted", async () => {
    const user = userEvent.setup();
    renderBar(false);
    const field = screen.getByRole("combobox", { name: "Command" });
    await user.type(field, "where are my connections?{Enter}");
    expect((await screen.findByRole("status")).textContent).toContain(
      "No match",
    );
  });
});
