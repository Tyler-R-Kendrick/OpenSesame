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
import { buildSupportPageContext } from "../tutorial/registry/context.js";
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
  cleanup();
  Object.assign(vaultHooksSeams, originalVaultHooks);
  Object.assign(supportSessionSeams, originalSessionSeams);
});

describe("CommandBar — command or ask", () => {
  it("hands a sentence no verb claims to Support as a question", async () => {
    installEngine(fakeAgentAnswering("Connections live under the rail."));
    const user = userEvent.setup();
    renderBar(true);
    const field = screen.getByRole("textbox", { name: "Command" });
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
    installEngine(fakeAgentAlwaysUnavailable());
    const user = userEvent.setup();
    renderBar(true);
    const field = screen.getByRole("textbox", { name: "Command" });
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

  it("still runs commands, and still shrugs, with no Support mounted", async () => {
    const user = userEvent.setup();
    renderBar(false);
    const field = screen.getByRole("textbox", { name: "Command" });
    await user.type(field, "where are my connections?{Enter}");
    expect((await screen.findByRole("status")).textContent).toContain(
      "No match",
    );
  });
});
