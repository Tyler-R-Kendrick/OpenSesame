/**
 * Asking a circle to approve sharing something (ADR 0186): what a person can
 * be asked about, the grant that goes in the request, and how a request in
 * flight reads. Pure, so every state of a request can be read without drawing
 * one.
 *
 * The vocabulary is the share ledger's own (`local-share-grants`): the
 * policies a kind of resource allows and the durations it offers, so a grant
 * the circle approves is one the ledger will write.
 */

import {
  SHARE_DURATIONS,
  SHARE_POLICIES,
  type ShareKind,
} from "@opensesame/app-core/lib/local-share-grants.js";
import type { AskView } from "@opensesame/app-core/lib/quorum/desk/index.js";
import type { LedgerStatus } from "@opensesame/app-core/lib/quorum/ledger-types.js";
import type { Grant } from "@opensesame/app-core/lib/quorum/types.js";
import type { Folder, VaultItem } from "@opensesame/vault-core";
import { type Mark, when } from "../row-model.js";
import type { Choice } from "./Choices.js";

/** What a circle can be asked to share: one item, or a folder. */
export type AskKind = Extract<ShareKind, "item" | "folder">;

export const ASK_KINDS = [
  { value: "item", label: "Item" },
  { value: "folder", label: "Folder" },
] as const satisfies readonly Choice<AskKind>[];

export type Target = Readonly<{ id: string; label: string }>;

function itemLabel(item: VaultItem, folders: readonly Folder[]): string {
  const folder = item.folderId
    ? folders.find((entry) => entry.id === item.folderId)
    : undefined;
  return (folder ? `${folder.name} / ${item.name}` : item.name).slice(0, 128);
}

/** The items or folders of the open vault a request can name. */
export function targetsOf(
  vault: Readonly<{ items: readonly VaultItem[]; folders: readonly Folder[] }>,
  kind: AskKind,
): Target[] {
  if (kind === "folder") {
    return vault.folders
      .filter((folder) => folder.name.trim() !== "")
      .map((folder) => ({ id: folder.id, label: folder.name.slice(0, 128) }));
  }
  return vault.items
    .filter((item) => item.deletedAt === null && item.name.trim() !== "")
    .map((item) => ({ id: item.id, label: itemLabel(item, vault.folders) }));
}

/** The policies the share ledger allows on this kind, in its own words. */
export function policiesFor(kind: AskKind): Choice<string>[] {
  return SHARE_POLICIES[kind].map(({ id, label }) => ({
    value: id,
    label,
  }));
}

export const DURATIONS: readonly Choice<number>[] = SHARE_DURATIONS.map(
  ({ seconds, label }) => ({ value: seconds, label }),
);

export function grantOf(input: {
  principalId: string;
  kind: AskKind;
  target: Target;
  policy: string;
  durationSeconds: number;
}): Grant {
  return {
    principalId: input.principalId,
    resourceKind: input.kind,
    resourceId: input.target.id,
    resourceLabel: input.target.label,
    policy: input.policy,
    durationSeconds: input.durationSeconds,
  };
}

/** Where a request in flight stands, as a mark. */
export function askMark(status: LedgerStatus): Mark {
  switch (status.state) {
    case "collecting":
      return {
        tone: "idle",
        label: `Collecting approvals until ${when(status.closesAt)}`,
      };
    case "approval_closed":
      return { tone: "warn", label: "Approvals closed before enough came in" };
    case "waiting":
      return {
        tone: "idle",
        label: `Waits until ${when(status.releasableAt)}`,
      };
    case "authorized":
      return { tone: "ok", label: `Approved until ${when(status.until)}` };
    case "executed":
      return { tone: "ok", label: "Shared" };
    case "cancelled":
      return { tone: "err", label: "Cancelled by the owner" };
    case "expired":
      return { tone: "err", label: "Expired" };
    case "releasable":
    case "complete":
      return { tone: "idle", label: "Under way" };
  }
}

/** "2 of 3 approved", and when a wait ends. */
export function askFact(view: AskView, contacts: number): string {
  const approved = `${view.approvedBy.length} of ${contacts} approved`;
  return view.status.state === "waiting"
    ? `${approved} · waits until ${when(view.status.releasableAt)}`
    : approved;
}

/** What the request asks for, by the name of the thing and the policy. */
export function askName(view: AskView): string {
  const grant = view.request.grant;
  return grant ? `${grant.resourceLabel} · ${grant.policy}` : "A request";
}
