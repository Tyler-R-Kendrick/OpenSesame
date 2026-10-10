/**
 * What the Recovery panel and its sheets say about a recovery, as plain
 * sentences (ADR 0186 §10). Pure, so a test reads every state without drawing
 * one.
 *
 * Nothing here reads a key, a share or a recovered document. A contact is
 * named by the label the owner signed into the circle's policy, looked up by
 * the id a packet carries; an id the policy does not list is never named.
 */

import type { Json } from "@opensesame/app-core/lib/quorum/canonical.js";
import type {
  Progress,
  RecoveryView,
} from "@opensesame/app-core/lib/quorum/desk/index.js";
import type { Packet } from "@opensesame/app-core/lib/quorum/packets.js";
import { countText, when } from "../row-model.js";

/** "1 of 2", or "1 of 2 groups" where the rule asks for groups: a count of contacts would be a wrong number there. */
function counted(progress: Progress): string {
  const groups =
    progress.unit === "groups"
      ? ` ${progress.need === 1 ? "group" : "groups"}`
      : "";
  return `${progress.have} of ${progress.need}${groups}`;
}

/**
 * The one fact a sheet states about where a recovery stands, against what the
 * circle's rule asks for: "1 of 2 approved", "Waits until Oct 12, 3:20 PM",
 * "2 of 2 shares released", "1 of 2 groups approved".
 */
export function statusFact(view: RecoveryView): string {
  const { status, progress } = view;
  switch (status.state) {
    case "waiting":
      return `Waits until ${when(status.releasableAt)}`;
    case "releasable":
    case "complete":
      return `${counted(progress.releases)} ${progress.releases.unit === "groups" ? "released" : "shares released"}`;
    default:
      return `${counted(progress.approvals)} approved`;
  }
}

/** The recovery can be opened: enough shares are released. */
export function canOpen(view: RecoveryView): boolean {
  return view.status.state === "complete";
}

/**
 * The contacts need the approvals so far to release: once enough have
 * approved, and until enough shares are in.
 */
export function wantsApprovals(view: RecoveryView): boolean {
  return view.status.state === "waiting" || view.status.state === "releasable";
}

/** The names of the contacts these ids stand for; an id the policy does not list is left out. */
export function namesOf(
  view: RecoveryView,
  ids: readonly string[],
): readonly string[] {
  return ids.flatMap((id) => {
    const name = view.names[id];
    return name === undefined ? [] : [name];
  });
}

/** A contact to ask again: the id the release came with and the name the policy gives it. */
export type Contact = Readonly<{ id: string; name: string }>;

/** Whom to ask to release again, by name; a contact the policy does not name is "a contact". */
export function askAgainWho(
  view: RecoveryView,
  ids: readonly string[],
): readonly Contact[] {
  return ids.map((id) => ({ id, name: view.names[id] ?? "a contact" }));
}

function from(what: string, names: readonly string[]): string {
  return names.length === 0 ? what : `${what} from ${names.join(", ")}`;
}

/**
 * What a valid paste is, before a key is pressed: its kind and, from the
 * policy's own names, who it says it is from. Nothing of the packet itself.
 */
export function describeAnswer(
  view: RecoveryView,
): (packet: Packet) => string | null {
  return (packet) => {
    switch (packet.kind) {
      case "approval":
        return from("An approval", namesOf(view, [packet.value.guardianId]));
      case "approvals":
        return from(
          countText(packet.value.length, "approval"),
          namesOf(
            view,
            packet.value.map((approval) => approval.guardianId),
          ),
        );
      case "release":
        return from("A release", namesOf(view, [packet.value.guardianId]));
      default:
        return null;
    }
  };
}

/** The recovered document as the text of a file. It leaves only by download or import. */
export function documentText(doc: Json): string {
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/** The file a recovered document is saved as. */
export function recoveredFileName(label: string): string {
  return `recovered-${label}.json`;
}

/** What a screen reader is told the panel holds, said only when it changes. */
export function panelSaid(recoveries: number, recovered: number): string {
  const parts = [countText(recoveries, "recovery", "recoveries")];
  if (recovered > 0) parts.push(`${recovered} recovered`);
  return parts.join(", ");
}
