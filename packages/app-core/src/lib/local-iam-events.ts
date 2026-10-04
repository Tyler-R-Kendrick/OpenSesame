import { type BroadcastLike, openBroadcast } from "../ports.js";
import { emitActivity } from "./activity-log.js";

const events = new EventTarget();
const otherTabs = new EventTarget();

/** Same-origin tabs only, and a hint: a receiver re-reads sealed state. */
export const LOCAL_IAM_CHANNEL = "opensesame:local-iam";

let channel: BroadcastLike | null | undefined;

function relay(): BroadcastLike | null {
  if (channel !== undefined) return channel;
  try {
    channel = openBroadcast(LOCAL_IAM_CHANNEL);
  } catch {
    channel = null;
  }
  // The message's content is never read: any script on this origin could
  // post one, and at most it makes a tab read its own sealed records again.
  if (channel) {
    channel.onmessage = () => otherTabs.dispatchEvent(new Event("change"));
  }
  return channel;
}

/** No identity, credential or vault data is carried in these invalidations. */
export function notifyLocalIamChange(): void {
  events.dispatchEvent(new Event("change"));
  try {
    relay()?.postMessage({ type: "changed" });
  } catch {
    // A closed channel loses the hint; the next read sees the records.
  }
  emitActivity({
    category: "identity",
    type: "identity.changed",
    summary: "Identity or access state changed",
    outcome: "info",
  });
}

export function subscribeLocalIamChanges(listener: () => void): () => void {
  events.addEventListener("change", listener);
  return () => events.removeEventListener("change", listener);
}

/**
 * Be told when another tab of this origin changed the sealed identity or
 * access records. A change made in this tab is not announced here: the
 * listener of `subscribeLocalIamChanges` already has it. Nothing is carried;
 * the listener reads what it needs from the vault.
 */
export function subscribeLocalIamChangesFromOtherTabs(
  listener: () => void,
): () => void {
  relay();
  otherTabs.addEventListener("change", listener);
  return () => otherTabs.removeEventListener("change", listener);
}

/** Test-only: drop the channel so a case opens a fresh one. */
export function resetLocalIamChannelForTest(): void {
  try {
    channel?.close();
  } catch {
    // already closed
  }
  channel = undefined;
}
