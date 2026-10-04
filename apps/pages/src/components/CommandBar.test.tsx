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
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
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
    await user.type(field, "/search gi");
    const names = screen.getByRole("listbox", { name: "Commands" });
    expect(names.textContent).toContain("GitHub");
    expect(names.textContent).not.toContain("s3cret-value");
    await user.keyboard("{Enter}");
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain(
        "Searching for “GitHub”",
      ),
    );
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
