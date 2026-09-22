/**
 * How a support suite mounts the panel and drives it.
 *
 * Split out of `support.test.tsx` when that file crossed the module-size
 * budget (ADR 0093). `support-test-engine.ts` beside it owns the engine; this
 * owns the seams, the render, and the panel's affordances. A suite calls
 * `resetSupport()` from its own `afterEach`. Test support: never imported by
 * the app.
 */

import type { FakeSupportAgent } from "@opensesame/support-agent";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { expect } from "vitest";
import { registerTutorialRealm } from "../registry/optional-tutorials.test-support.js";
import {
  SupportProvider,
  type SupportTransport,
  supportSessionSeams,
} from "../session.js";
import { SupportLauncher } from "./SupportLauncher.js";
import { type TestEngine, buildEngine } from "./support-test-engine.js";

const original = { ...supportSessionSeams };
// The identity help these answers cite belongs to the identity capability;
// a panel on a deployment without it has nothing written to draw from.
let revokeRealm: (() => void) | null = null;
let engine: TestEngine | null = null;
let cleared = 0;
const lockHandlers = new Set<() => void>();

/** How many times the session cleared the overlay's targets. */
export function clearedCount(): number {
  return cleared;
}

/**
 * The two seams every mount shares: the lock feed the panel subscribes to,
 * and the target clearing it does on the way out. A suite that supplies its
 * own `loadEngine` spreads these beside it.
 */
export function supportLifecycleSeams() {
  return {
    onLock: (handler: () => void) => {
      lockHandlers.add(handler);
      return () => lockHandlers.delete(handler);
    },
    clearTargets: () => {
      cleared += 1;
    },
  };
}

/** Render the launcher with whatever seams the suite has already installed. */
export function renderLauncher() {
  return render(
    <MemoryRouter initialEntries={["/vault"]}>
      <SupportProvider>
        <SupportLauncher />
      </SupportProvider>
    </MemoryRouter>,
  );
}

export function mount(
  agent: FakeSupportAgent,
  transport: SupportTransport = "on-device",
  warning: string | null = null,
) {
  revokeRealm?.();
  revokeRealm = registerTutorialRealm();
  const built = buildEngine(agent, transport, warning);
  engine = built;
  Object.assign(supportSessionSeams, {
    loadEngine: () => Promise.resolve(built),
    ...supportLifecycleSeams(),
  });
  return { ...renderLauncher(), engine: built };
}

export function lockTheVault(): void {
  for (const handler of [...lockHandlers]) handler();
}

export async function openPanel(user: ReturnType<typeof userEvent.setup>) {
  const affordance = screen.getByRole("button", { name: "Support" });
  await user.click(affordance);
  const panel = await screen.findByRole("dialog", { name: "Support" });
  await waitFor(() =>
    expect(panel.contains(document.activeElement)).toBe(true),
  );
  return { affordance, panel };
}

/** The composer, typed, so `disabled` can be read without a cast. */
export function composer(): Promise<HTMLInputElement> {
  return screen.findByLabelText<HTMLInputElement>("Ask about this screen");
}

export async function ask(
  user: ReturnType<typeof userEvent.setup>,
  question: string,
): Promise<void> {
  const field = await composer();
  await waitFor(() => expect(field.disabled).toBe(false));
  await user.type(field, question);
  await user.click(screen.getByRole("button", { name: "Ask" }));
}

/** One teardown for a support suite: the render, the realm and the seams. */
export function resetSupport(): void {
  cleanup();
  revokeRealm?.();
  revokeRealm = null;
  Object.assign(supportSessionSeams, original);
  lockHandlers.clear();
  engine = null;
  cleared = 0;
}
