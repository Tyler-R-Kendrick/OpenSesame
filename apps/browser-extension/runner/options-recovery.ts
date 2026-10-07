import { createApiClient } from "@opensesame/api-client";
import { backupId, createRecoveryKey, openBackup } from "./backup";
import { recoverBackup } from "./host";
import {
  type OriginalOwner,
  originalOwner,
  ownerFetch,
  ownerStore,
} from "./original-owner";
import type { WorkflowSecurity } from "./password-workflow-handoff";
import { RunnerSettings } from "./settings";
import { type RawStore, SealedKv } from "./store";
import { RunnerVault } from "./vault";
interface RecoveryView {
  security: WorkflowSecurity;
  raw(): RawStore;
  resolveBase(owner: OriginalOwner): Promise<string>;
  element(id: string): HTMLElement;
  say(text: string): void;
  render(owner: OriginalOwner): Promise<void>;
}
function textarea(view: RecoveryView, id: string) {
  const field = view.element(id);
  if (!(field instanceof HTMLTextAreaElement)) throw new Error(`Missing ${id}`);
  return field;
}
function scopedKv(view: RecoveryView, owner: OriginalOwner) {
  return new SealedKv(
    ownerStore(view.raw(), owner),
    undefined,
    owner.authorize,
  );
}
async function readBackup(
  view: RecoveryView,
  owner: OriginalOwner,
  handle: string,
) {
  const token = await new RunnerSettings(scopedKv(view, owner)).token();
  owner.check();
  await owner.authorize();
  owner.check();
  if (!token) {
    view.say("Needs a Host session.");
    return null;
  }
  const baseUrl = await view.resolveBase(owner);
  owner.check();
  await owner.authorize();
  owner.check();
  const client = createApiClient({
    baseUrl,
    accessToken: token,
    fetchImpl: ownerFetch(owner),
  });
  const bytes = await recoverBackup(client, backupId(handle), owner);
  owner.check();
  await owner.authorize();
  owner.check();
  if (!bytes) view.say("The Host holds no backup for that candidate.");
  return bytes;
}
/** Actual page actions return their whole task, including authority-fenced publication. */
export function optionsRecovery(view: RecoveryView) {
  let display = 0;
  async function recover(handle: string) {
    let owner: OriginalOwner | undefined;
    let operation = 0;
    try {
      owner = originalOwner(view.security);
      await owner.authorize();
      owner.check();
      operation = ++display;
      const out = view.element("revealed");
      out.textContent = "";
      const bytes = await readBackup(view, owner, handle);
      owner.check();
      if (!bytes) return;
      const key: JsonWebKey = JSON.parse(textarea(view, "reveal-key").value);
      const plain = await openBackup(key, bytes, owner);
      owner.check();
      await owner.authorize();
      owner.check();
      if (operation !== display) return;
      out.textContent = plain;
      view.say("Shown for 30 seconds.");
      setTimeout(() => {
        try {
          owner?.check();
          if (operation === display) out.textContent = "";
        } catch {
          /* A predecessor cannot clear a successor's display. */
        }
      }, 30_000);
    } catch {
      try {
        if (owner) {
          owner.check();
          await owner.authorize();
          owner.check();
          if (operation === display)
            view.say("That key does not open this backup.");
        }
      } catch {
        /* Revoked work publishes neither data nor errors. */
      }
    }
  }
  async function createOwnerRecoveryKey() {
    try {
      if (!view.security.permit()) {
        view.say("Create or unlock your vault before creating a recovery key.");
        return;
      }
      const owner = originalOwner(view.security);
      await owner.authorize();
      owner.check();
      const pair = await createRecoveryKey();
      owner.check();
      await owner.authorize();
      owner.check();
      await new RunnerVault(scopedKv(view, owner)).setRecipient(
        pair.recipient.jwk,
      );
      owner.check();
      await owner.authorize();
      owner.check();
      textarea(view, "recovery-private").value = JSON.stringify(
        pair.privateJwk,
      );
      view.element("recovery-private-field").hidden = false;
      view.say(
        "Recovery key pinned. Save the private key now; it is not kept.",
      );
      await view.render(owner);
    } catch {
      /* Never publish a predecessor's generated key. */
    }
  }
  return { recover, createOwnerRecoveryKey };
}
