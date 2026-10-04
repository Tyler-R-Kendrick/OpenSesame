import { type BroadcastLike, openBroadcast } from "../ports.js";
import { emitActivity } from "./activity-log.js";

const events = new EventTarget();
const otherTabs = new EventTarget();

/** Same-origin tabs only, and a hint: a receiver re-reads sealed state. */
export const LOCAL_IAM_CHANNEL = "opensesame:local-iam";

/**
 * The most often a tab hears another tab's change: once now, and once more at
 * the end of the window if anything arrived inside it. Every panel that reads
 * on this hint reads sealed storage under a lock, so a script on this origin
 * posting in a loop would otherwise make each of them read as fast as it can
 * post. They share this one bound instead of each keeping its own.
 */
export const OTHER_TAB_WINDOW_MS = 200;

let channel: BroadcastLike | null | undefined;
let cooling: ReturnType<typeof setTimeout> | undefined;
let arrivedWhileCooling = false;

function heardFromAnotherTab(): void {
  if (cooling !== undefined) {
    arrivedWhileCooling = true;
    return;
  }
  otherTabs.dispatchEvent(new Event("change"));
  cooling = setTimeout(() => {
    cooling = undefined;
    if (arrivedWhileCooling) {
      arrivedWhileCooling = false;
      heardFromAnotherTab();
    }
  }, OTHER_TAB_WINDOW_MS);
}

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
    channel.onmessage = heardFromAnotherTab;
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
  clearTimeout(cooling);
  cooling = undefined;
  arrivedWhileCooling = false;
  try {
    channel?.close();
  } catch {
    // already closed
  }
  channel = undefined;
}
