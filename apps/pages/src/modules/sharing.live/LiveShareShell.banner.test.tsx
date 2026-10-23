/** @vitest-environment jsdom */
import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { holdLiveLink } from "@opensesame/app-core/lib/live/link.js";
import * as session from "@opensesame/app-core/lib/live/session.js";
import { createItem } from "@opensesame/vault-core";
import { act, render, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { vaultShareSnapshot } from "../../components/vault-share-seat.js";
import { classify } from "../../lib/capabilities/classification.js";
import { LiveSessionBanner } from "../../sections/vault/LiveSessionBanner.js";
import { withPassword } from "../../sections/vault/account.test-support.js";
import { LiveShareShell } from "./LiveShareShell.js";
import {
  asked,
  enter,
  github,
  host,
  installLiveFocusTests,
  openJoin,
  pairedJoiner,
  press,
  type,
} from "./live-focus-test-support.js";

installLiveFocusTests();

const repository = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../..",
);
const pages = resolve(repository, "apps/pages");
const core = resolve(repository, "packages/app-core");
const banner = resolve(pages, "src/sections/vault/LiveSessionBanner.tsx");

function projectImport(from: string, name: string): string | null {
  const path = name.startsWith(".")
    ? resolve(dirname(from), name)
    : name.startsWith("@opensesame/app-core/")
      ? resolve(core, "src", name.slice("@opensesame/app-core/".length))
      : null;
  if (path === null) return null;
  const candidates = path.endsWith(".js")
    ? [`${path.slice(0, -3)}.ts`, `${path.slice(0, -3)}.tsx`]
    : [path];
  const found = candidates.find(existsSync);
  if (!found) throw new Error(`Unresolved project import: ${name}`);
  return found;
}

function executableImports(file: string): string[] {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const names: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly) ||
      (ts.isExportDeclaration(node) && !node.isTypeOnly)
    ) {
      if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier))
        names.push(node.moduleSpecifier.text);
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0])
    )
      names.push(node.arguments[0].text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return names;
}

function optionalReachability(): string[] {
  const visited = new Set<string>();
  const pending = [banner];
  const optional: string[] = [];
  while (pending.length) {
    const file = pending.pop();
    if (!file || visited.has(file)) continue;
    visited.add(file);
    const path = relative(file.startsWith(pages) ? pages : core, file);
    const owner = classify(path);
    if (owner === null) throw new Error(`Unclassified source: ${path}`);
    if (owner.classification === "optional") {
      optional.push(path);
      continue;
    }
    for (const name of executableImports(file)) {
      const imported = projectImport(file, name);
      if (imported) pending.push(imported);
    }
  }
  return optional;
}

function providedBanner() {
  return render(
    <MemoryRouter>
      <LiveShareShell>
        <LiveSessionBanner />
      </LiveShareShell>
    </MemoryRouter>,
  );
}

async function joinWholeVault() {
  const bank = createItem("account", "Bank");
  withPassword(bank, "another private password");
  let items = [github, bank];
  session.liveSeams.items = () => items;
  const panel = await host("invite", "read");
  type(panel.getByLabelText("Share"), "vault");
  press(panel.getByRole("button", { name: "Share this vault" }));
  await panel.findByRole("img", { name: "Live" });
  const owner = session.currentHost();
  holdLiveLink(owner?.link ?? null);
  const joiner = openJoin();
  const request = await asked(joiner, owner?.code ?? "");
  type(panel.getByLabelText("Paste a join request"), request);
  enter(panel.getByLabelText("Paste a join request"));
  press(await panel.findByRole("button", { name: "Let Ada in" }));
  await panel.findByRole("button", { name: "Copy the reply code for Ada" });
  const reply = joiner.getByLabelText("The owner's reply code");
  type(reply, owner?.state.guests[0]?.reply ?? "");
  enter(reply);
  await joiner.findByRole("img", { name: "Joined Team" });
  return (item: typeof github) => {
    items = [...items, item];
  };
}

describe("the live banner's capability seat", () => {
  it("keeps optional executable code unreachable from the core vault banner", () => {
    expect(optionalReachability()).toEqual([]);
  });

  it("does not read or subscribe to live state without its provider", () => {
    const read = vi.spyOn(session, "currentGuest");
    const subscribe = vi.spyOn(session, "onLiveSessionChange");
    const view = render(<LiveSessionBanner />);
    expect(view.container.innerHTML).toBe("");
    expect(read).not.toHaveBeenCalled();
    expect(subscribe).not.toHaveBeenCalled();
  });

  it("stays absent without its provider even while a real guest is joined", async () => {
    await pairedJoiner("read");
    const guest = session.currentGuest();
    expect(guest?.status.at).toBe("joined");
    const view = render(
      <MemoryRouter>
        <LiveSessionBanner />
      </MemoryRouter>,
    );
    expect(view.container.innerHTML).toBe("");
    expect(session.currentGuest()).toBe(guest);
    expect(guest?.status.at).toBe("joined");
  });

  it("draws the real singular catalog without secrets and clears on local leave", async () => {
    await pairedJoiner("read");
    const guest = session.currentGuest();
    const view = providedBanner();
    const banner = within(view.container).getByLabelText("Live session");
    expect(banner.textContent).toContain("1 shared item");
    expect(banner.textContent).not.toContain("correct horse battery staple");
    expect(
      within(banner)
        .getByRole("link", { name: "Open shared items" })
        .getAttribute("href"),
    ).toBe("/live");
    act(() => session.leaveLive());
    expect(within(view.container).queryByLabelText("Live session")).toBeNull();
    expect(session.currentGuest()).toBeNull();
    expect(guest?.status.at).toBe("ended");
  });

  it("tracks an actual catalog update on the same guest without replacing the session", async () => {
    const addItem = await joinWholeVault();
    const guest = session.currentGuest();
    const owner = session.currentHost();
    if (!guest || !owner) throw new Error("Expected paired live peers");
    const view = providedBanner();
    const banner = within(view.container).getByLabelText("Live session");
    expect(banner.textContent).toContain("2 shared items");
    const changedSession = vi.fn();
    const stop = session.onLiveSessionChange(changedSession);
    const added = createItem("account", "New share");
    withPassword(added, "never shown in the banner");
    addItem(added);
    act(() => owner.refreshCatalog());
    await waitFor(() => expect(banner.textContent).toContain("3 shared items"));
    expect(session.currentGuest()).toBe(guest);
    expect(changedSession).not.toHaveBeenCalled();
    expect(banner.textContent).not.toContain("never shown in the banner");
    stop();
  });

  it("draws the real plural catalog and releases only its subscription on disposal", async () => {
    await joinWholeVault();
    const guest = session.currentGuest();
    expect(guest?.status.at).toBe("joined");
    if (!guest) throw new Error("Expected the paired guest");
    const subscribeStatus = guest.subscribe.bind(guest);
    const disposedStatus = vi.fn();
    vi.spyOn(guest, "subscribe").mockImplementation((listener) => {
      const stop = subscribeStatus(listener);
      return () => {
        stop();
        disposedStatus();
      };
    });
    const listen = session.onLiveSessionChange;
    const disposed = vi.fn();
    vi.spyOn(session, "onLiveSessionChange").mockImplementation((listener) => {
      const stop = listen(listener);
      return () => {
        stop();
        disposed();
      };
    });
    const view = providedBanner();
    const banner = within(view.container).getByLabelText("Live session");
    expect(banner.textContent).toContain("2 shared items");
    expect(banner.textContent).not.toContain("another private password");
    expect(vaultShareSnapshot()?.Banner).toBeTruthy();
    view.unmount();
    expect(disposed).toHaveBeenCalledTimes(1);
    expect(disposedStatus).toHaveBeenCalledTimes(1);
    expect(vaultShareSnapshot()).toBeNull();
    expect(session.currentGuest()).toBe(guest);
    expect(guest?.status.at).toBe("joined");
  });
});
