/** @vitest-environment jsdom */
import type { CompositionSnapshot } from "@opensesame/app-core/lib/capabilities/store-types.js";
import { capabilityPorts } from "@opensesame/app-core/lib/configuration/capabilities-ports.js";
import {
  double,
  installDoublePorts,
} from "@opensesame/app-core/lib/configuration/doubles/test-support.js";
import { mailboxItem } from "@opensesame/app-core/lib/password-reset/mailbox.test-support.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import type { VaultItem } from "@opensesame/vault-core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ResetEmailField } from "./ResetEmailField.js";

installDoublePorts();

/** What the test changes between renders. */
type Scene = { approved: boolean; items: VaultItem[] };

const state: Scene = { approved: false, items: [] };

/** The double's snapshot, with exactly `approved` as the approved capabilities. */
function snapshotApproving(approved: readonly string[]): CompositionSnapshot {
  const base = double.getSnapshot();
  if (base.plan === null) throw new Error("the double resolves a plan");
  return { ...base, plan: { ...base.plan, approvedCapabilities: approved } };
}

const mailbox = (address: string, name = "") => mailboxItem({ address }, name);

beforeEach(() => {
  state.approved = false;
  state.items = [];
  const hidden = snapshotApproving([]);
  const shown = snapshotApproving(["ai.password-reset"]);
  Object.assign(capabilityPorts, {
    compositionStore: {
      ...double,
      getSnapshot: () => (state.approved ? shown : hidden),
    },
  });
  const base = vaultStore.getSnapshot();
  const snapshots = new Map<
    VaultItem[],
    ReturnType<typeof vaultStore.getSnapshot>
  >();
  vi.spyOn(vaultStore, "getSnapshot").mockImplementation(() => {
    const cached = snapshots.get(state.items);
    if (cached) return cached;
    const next = { ...base, items: state.items };
    snapshots.set(state.items, next);
    return next;
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  state.approved = false;
  state.items = [];
});

describe("ResetEmailField", () => {
  it("stays hidden until password reset is on and a mailbox exists", () => {
    state.items = [mailbox("a@example.com")];
    const { container, rerender } = render(
      <ResetEmailField emailId={undefined} onChange={() => {}} />,
    );
    expect(container.querySelector("select")).toBeNull();
    state.approved = true;
    rerender(<ResetEmailField emailId={undefined} onChange={() => {}} />);
    expect(screen.getByRole("combobox", { name: "Reset email" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "a@example.com" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "None" })).toBeTruthy();
  });

  it("draws nothing when the vault has no mailbox and the login names none", () => {
    state.approved = true;
    const { container } = render(
      <ResetEmailField emailId={undefined} onChange={() => {}} />,
    );
    expect(container.querySelector("select")).toBeNull();
  });

  it("lists every mailbox, by name when it has one, and writes the chosen item's id", () => {
    state.approved = true;
    const home = mailbox("a@example.com", "Home");
    const work = mailbox("b@example.com");
    state.items = [work, home];
    const chosen: Array<string | undefined> = [];
    render(
      <ResetEmailField
        emailId={undefined}
        onChange={(id) => chosen.push(id)}
      />,
    );
    const options = screen
      .getAllByRole("option")
      .map((option) => option.textContent);
    // Name order: "b@example.com" sorts before "Home".
    expect(options).toEqual(["None", "b@example.com", "Home (a@example.com)"]);
    const select = screen.getByRole("combobox", { name: "Reset email" });
    fireEvent.change(select, { target: { value: home.id } });
    fireEvent.change(select, { target: { value: "" } });
    expect(chosen).toEqual([home.id, undefined]);
  });

  it("shows None for a mailbox that is gone, and still offers the rest", () => {
    state.approved = true;
    state.items = [mailbox("a@example.com")];
    render(<ResetEmailField emailId="trashed-id" onChange={() => {}} />);
    const select = screen.getByRole("combobox", { name: "Reset email" });
    expect(select).toHaveProperty("value", "");
    expect(screen.getAllByRole("option")).toHaveLength(2);
  });

  it("is still drawn for a login whose mailbox is gone, so it can be cleared", () => {
    state.approved = true;
    render(<ResetEmailField emailId="trashed-id" onChange={() => {}} />);
    expect(screen.getByRole("combobox", { name: "Reset email" })).toBeTruthy();
  });
});
