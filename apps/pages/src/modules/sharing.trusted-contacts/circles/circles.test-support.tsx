/**
 * What the owner's sheets need to be driven the way a person drives them: the
 * clipboard seam that records every Copy, an open vault with a few items in
 * it, a desk that reads its records again when a step asks it to, and a Tab
 * that goes where a keyboard goes.
 */

import { LOCAL_DIRECTORY_PATH } from "@opensesame/app-core/lib/local-directory.js";
import { clearNotices } from "@opensesame/app-core/lib/notices.js";
import {
  type Clock,
  type Device,
  device,
} from "@opensesame/app-core/lib/quorum/desk/harness.test-support.js";
import {
  acceptInvitation,
  takeWelcome,
} from "@opensesame/app-core/lib/quorum/desk/index.js";
import { unlockTomb, writeFile } from "@opensesame/app-core/lib/vfs.js";
import { createItem, mintVaultKey } from "@opensesame/vault-core";
import type { Folder, VaultItem } from "@opensesame/vault-core";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import type { UserEvent } from "@testing-library/user-event";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { afterEach, beforeEach, expect } from "vitest";
import { vaultHooksSeams } from "../../../lib/vault/hooks.js";
import { deskOf } from "../trusted-contacts.test-support.js";
import { type Desk, deskSeams } from "../use-desk.js";

const original = { ...vaultHooksSeams };

export type Recorded = Readonly<{ copies: string[]; restore: () => void }>;

/** Record what the Copy keys put on the clipboard, in order. */
export function recordCopies(): Recorded {
  const copies: string[] = [];
  Object.assign(vaultHooksSeams, {
    useCopySecret: () => async (value: string) => {
      copies.push(value);
      return "copied" as const;
    },
  });
  return { copies, restore: () => Object.assign(vaultHooksSeams, original) };
}

export const BANK_FOLDER: Folder = {
  id: "folder-bank",
  name: "Banking",
  createdAt: "2026-10-01T00:00:00.000Z",
};

export const EMERGENCY_FOLDER: Folder = {
  id: "folder-emergency",
  name: "Emergency",
  createdAt: "2026-10-01T00:00:00.000Z",
};

/** The vault the harness's circles are over: their collection is a folder called Emergency. */
export function emergencyVault(): () => void {
  const passport = {
    ...createItem("secret", "Passport"),
    value: "passport-pass-9",
    folderId: EMERGENCY_FOLDER.id,
  };
  return openVaultWith(
    [...someItems(), passport],
    [BANK_FOLDER, EMERGENCY_FOLDER],
  );
}

/** A few items: one loose, one in a folder, so a folder circle and a whole-vault one differ. */
export function someItems(): VaultItem[] {
  const loose = { ...createItem("secret", "Router"), value: "router-pass-1" };
  const banked = {
    ...createItem("secret", "Savings"),
    value: "savings-pass-2",
    folderId: BANK_FOLDER.id,
  };
  return [loose, banked];
}

/** Make `useVault()` answer with an open vault holding these. */
export function openVaultWith(
  items: readonly VaultItem[],
  folders: readonly Folder[] = [BANK_FOLDER],
): () => void {
  const was = vaultHooksSeams.useVault;
  vaultHooksSeams.useVault = () => ({
    ...was(),
    status: "unlocked",
    tomb: "tomb",
    guest: false,
    items: [...items],
    rawItems: [...items],
    folders: [...folders],
  });
  return () => {
    vaultHooksSeams.useVault = was;
  };
}

/**
 * Hands `children` a desk over `owner`'s ports, and a new one each time a
 * step asks it to refresh, as the real hook's records change with the vault.
 */
export function WithDesk({
  owner,
  children,
}: {
  owner: Device;
  children: (desk: Desk) => ReactNode;
}) {
  const [desk, setDesk] = useState<Desk | null>(null);
  const load = useRef<() => Promise<void>>(async () => undefined);
  load.current = useCallback(async () => {
    const read = await deskOf(owner);
    setDesk({ ...read, refresh: () => load.current() });
  }, [owner]);
  useEffect(() => {
    void load.current();
  }, []);
  return desk ? <>{children(desk)}</> : null;
}

/** Press Tab until `match` holds of the focused element; says where it stopped if it never does. */
export async function tabTo(
  user: UserEvent,
  match: (element: Element) => boolean,
  what: string,
  limit = 80,
): Promise<Element> {
  for (let presses = 0; presses < limit; presses += 1) {
    const active = document.activeElement;
    if (active && active !== document.body && match(active)) return active;
    await user.tab();
  }
  throw new Error(
    `Tab never reached ${what}; it stopped on ${document.activeElement?.outerHTML.slice(0, 120)}`,
  );
}

export const byId = (id: string) => (element: Element) => element.id === id;

export const byName = (name: string) => (element: Element) =>
  element.getAttribute("aria-label") === name;

/** Three contacts' devices, each with its own security key, sharing the owner's clock. */
export function contacts(clock: Clock, names: readonly string[]) {
  return new Map(names.map((name) => [name, device(clock)]));
}

/** A contact reads the invitation and answers it, as their own device does. */
export async function answer(
  contact: Device,
  invite: string,
  name: string,
): Promise<string> {
  const { enrollment } = await acceptInvitation(contact, {
    packet: invite,
    name,
    keyLabels: ["Security key"],
  });
  return enrollment;
}

/** A contact takes the packet dealt to them and returns their receipt. */
export async function take(
  contact: Device,
  welcome: string,
): Promise<string | null> {
  return (await takeWelcome(contact, welcome)).receipt;
}

/** A key inside the open sheet (the page behind a sheet may hold keys of the same name). */
export function sheetKey(name: string): HTMLElement {
  return within(screen.getByRole("dialog")).getByRole("button", { name });
}

/** Name a circle, choose what it protects, make the invitation, and copy it. Returns the invitation. */
export async function startCircle(
  user: UserEvent,
  copies: readonly string[],
  name: string,
  protects?: string,
): Promise<string> {
  await user.type(screen.getByLabelText("Name"), name);
  if (protects) await user.click(sheetKey(protects));
  await user.click(sheetKey("Make the invitation"));
  await user.click(
    await screen.findByRole("button", { name: "Copy invitation" }),
  );
  await waitFor(() =>
    expect(copies.at(-1)?.startsWith("osq1.invite.")).toBe(true),
  );
  return copies.at(-1) ?? "";
}

/** A contact answers the invitation and the owner adds the answer. */
export async function addContact(
  user: UserEvent,
  invite: string,
  name: string,
  who: Device,
  household?: string,
): Promise<void> {
  const enrollment = await answer(who, invite, name);
  if (household) await user.type(screen.getByLabelText("Household"), household);
  await user.click(screen.getByLabelText("A contact's answer"));
  await user.paste(enrollment);
  await user.click(screen.getByRole("button", { name: "Add this contact" }));
  await screen.findByRole("img", { name: `${name} has answered` });
}

export type LiveDesk = Readonly<{
  /** Resolves once the first desk is served. */
  ready: Promise<void>;
  /** Read the records again, as a change made elsewhere would. */
  refresh: () => Promise<void>;
  restore: () => void;
}>;

/**
 * Serve a desk that follows `owner`'s records: a step that refreshes it draws
 * the panels again with the records as they stand, as the real hook does.
 */
export function serveLiveDesk(owner: Device): LiveDesk {
  let current: Desk | null = null;
  const listeners = new Set<() => void>();
  const refresh = async (): Promise<void> => {
    current = { ...(await deskOf(owner)), refresh };
    for (const listener of listeners) listener();
  };
  const was = deskSeams.useDesk;
  deskSeams.useDesk = () =>
    useSyncExternalStore(
      (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      () => current,
    );
  return {
    ready: refresh(),
    refresh,
    restore: () => {
      deskSeams.useDesk = was;
    },
  };
}

export type SeededTomb = Readonly<{
  tomb: string;
  people: readonly { id: string; name: string }[];
}>;

/** An open tomb whose directory holds these people, as Access › Identity would have left it. */
export async function seedTomb(names: readonly string[]): Promise<SeededTomb> {
  const tomb = `circles-${crypto.randomUUID()}`;
  unlockTomb(tomb, (await mintVaultKey()).vaultKey);
  const people = names.map((name) => ({
    id: `local_${crypto.randomUUID()}`,
    name,
  }));
  const directory = {
    version: 2,
    revision: 1,
    entries: people.map((p) => ({ ...p, kind: "person", enabled: true })),
    memberships: [],
  };
  await writeFile(
    tomb,
    LOCAL_DIRECTORY_PATH,
    new TextEncoder().encode(JSON.stringify(directory)),
  );
  return { tomb, people };
}

export type SheetHarness = {
  /** Everything the Copy keys have put on the clipboard so far, in order. */
  copies: string[];
  /** Undone, last first, after each test. */
  restores: (() => void)[];
};

/**
 * Set up and tear down what every sheet test shares: the recording clipboard,
 * an open vault with a few items, and an empty tray. Call once at the top of a
 * test file.
 */
export function installSheetHarness(
  also: () => () => void = () => () => undefined,
): SheetHarness {
  const state: SheetHarness = { copies: [], restores: [] };
  beforeEach(() => {
    const recorded = recordCopies();
    state.copies = recorded.copies;
    state.restores = [recorded.restore, openVaultWith(someItems()), also()];
  });
  afterEach(() => {
    cleanup();
    for (const restore of state.restores.reverse()) restore();
    clearNotices();
  });
  return state;
}
