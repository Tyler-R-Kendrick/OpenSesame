/**
 * Scope adapters: search/counts/history/folders/attachments/previews/TOTP/passkey/connectors (UX-B).
 * All surfaces read only from cryptographically opened admitted plaintext.
 */

import type { PresentationClass } from "../access/context.js";
import { isString } from "../json-boundary.js";
import type { CompartmentItem, CompartmentPlaintext } from "./registry.js";
import type { OpenOutcome, PresentationSession } from "./session.js";

export type ScopedView = Readonly<{
  presentation: PresentationClass;
  items: readonly CompartmentItem[];
  folders: readonly string[];
  history: readonly string[];
  counts: Readonly<{
    total: number;
    folders: number;
    totp: number;
    passkeys: number;
    attachments: number;
  }>;
  connectors: readonly string[];
  locked: boolean;
  lockReason: string | null;
}>;

export type ScopeQuery = Readonly<{
  search?: string;
  folder?: string;
}>;

function emptyScoped(
  presentation: PresentationClass,
  locked: boolean,
  lockReason: string | null,
): ScopedView {
  return {
    presentation,
    items: [],
    folders: [],
    history: [],
    counts: { total: 0, folders: 0, totp: 0, passkeys: 0, attachments: 0 },
    connectors: [],
    locked,
    lockReason,
  };
}

export function projectScopedView(
  outcome: OpenOutcome,
  query: ScopeQuery = {},
  explicitSafeConnectorApprovals: ReadonlySet<string> = new Set(),
): ScopedView {
  if (outcome.kind === "locked") {
    return emptyScoped("locked", true, outcome.reason);
  }

  let items = [...outcome.plaintext.items];
  if (query.folder) {
    items = items.filter((i) => i.folder === query.folder);
  }
  if (query.search) {
    const q = query.search.toLowerCase();
    items = items.filter((i) => i.title.toLowerCase().includes(q));
  }

  const folders = [
    ...new Set(
      items.map((i) => i.folder).filter((f): f is string => Boolean(f)),
    ),
  ];
  const history = items.flatMap((i) => i.history ?? []);
  const connectors = projectConnectorRefs(
    outcome.session.presentation,
    items,
    explicitSafeConnectorApprovals,
  );

  return {
    presentation: outcome.presentation,
    items,
    folders,
    history,
    counts: {
      total: items.length,
      folders: folders.length,
      totp: items.filter((i) => i.hasTotp).length,
      passkeys: items.filter((i) => i.hasPasskey).length,
      attachments: items.filter((i) => i.hasAttachment).length,
    },
    connectors,
    locked: false,
    lockReason: null,
  };
}

export function projectConnectorRefs(
  presentation: PresentationClass,
  items: readonly CompartmentItem[],
  explicitSafeApprovals: ReadonlySet<string>,
): string[] {
  const refs = [
    ...new Set(
      items
        .map((i) => i.connectorRef)
        .filter((r): r is string => isString(r) && r.length > 0),
    ),
  ];
  if (presentation === "locked" || presentation === "unchanged") return [];
  if (presentation === "decoy" || presentation === "restricted") {
    return refs.filter((r) => explicitSafeApprovals.has(r));
  }
  return refs;
}

export function itemPreview(
  view: ScopedView,
  itemId: string,
): { title: string; preview: string | null } | null {
  if (view.locked) return null;
  const item = view.items.find((i) => i.id === itemId);
  if (!item) return null;
  return { title: item.title, preview: item.preview ?? null };
}

export function totpActionAllowed(view: ScopedView, itemId: string): boolean {
  if (view.locked) return false;
  const item = view.items.find((i) => i.id === itemId);
  return Boolean(item?.hasTotp);
}

export function passkeyActionAllowed(
  view: ScopedView,
  itemId: string,
): boolean {
  if (view.locked) return false;
  const item = view.items.find((i) => i.id === itemId);
  return Boolean(item?.hasPasskey);
}

export function attachmentPreviewAllowed(
  view: ScopedView,
  itemId: string,
): boolean {
  if (view.locked) return false;
  const item = view.items.find((i) => i.id === itemId);
  return Boolean(item?.hasAttachment);
}

export function admittedSwitcherTargets(
  session: PresentationSession,
): string[] {
  return session.admitted.map((a) => a.compartmentRef);
}

export type AccessibleProjection = Readonly<{
  roles: readonly { role: string; name: string }[];
  textNodes: readonly string[];
}>;

/** Accessible-tree / DOM projection from opened view only (AT-095). */
export function accessibleProjection(view: ScopedView): AccessibleProjection {
  if (view.locked) {
    return {
      roles: [{ role: "status", name: "Vault locked" }],
      textNodes: ["Vault locked"],
    } satisfies AccessibleProjection;
  }
  return {
    roles: view.items.map((i) => ({ role: "listitem", name: i.title })),
    textNodes: view.items.map((i) => i.title),
  } satisfies AccessibleProjection;
}

export function assertNoProtectedLeak(
  view: ScopedView,
  protectedTitles: readonly string[],
): void {
  const exposed = new Set(accessibleProjection(view).textNodes);
  for (const title of protectedTitles) {
    if (exposed.has(title)) {
      throw new Error("compartment_leak: protected title visible");
    }
  }
}

export function plaintextFromOpened(
  outcome: OpenOutcome,
): CompartmentPlaintext | null {
  return outcome.kind === "opened" ? outcome.plaintext : null;
}
