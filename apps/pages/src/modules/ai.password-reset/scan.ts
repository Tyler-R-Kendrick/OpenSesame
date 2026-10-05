/**
 * One pass of the mailbox check. A hit starts the existing website
 * password-reset ceremony with the link's https origin, and only when that
 * ceremony is available. A miss or a failed post is tried again later.
 */

import { hostFetch } from "@opensesame/app-core/lib/identity.js";
import {
  type ResetLoginRef,
  type ResetMailMessage,
  autonomousPasswordResetReady,
  listResetEmails,
  matchResetMail,
  passwordResetMailSeams,
} from "@opensesame/app-core/lib/password-reset-mail.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import type { VaultItem } from "@opensesame/vault-core";

const seen = new Set<string>();

export function clearPasswordResetSeen(): void {
  seen.clear();
}

export function startPasswordResetScan(signal: AbortSignal): void {
  const timer = setInterval(() => {
    void scanPasswordResetMail();
  }, 60_000);
  const stop = () => {
    clearInterval(timer);
    clearPasswordResetSeen();
  };
  if (signal.aborted) {
    stop();
    return;
  }
  signal.addEventListener("abort", stop, { once: true });
  void scanPasswordResetMail();
}

export async function scanPasswordResetMail(source?: {
  items?: readonly ResetLoginRef[];
  post?: (origin: string) => Promise<boolean>;
}): Promise<void> {
  if (!(await autonomousPasswordResetReady())) return;
  const emails = listResetEmails();
  const items = source?.items ?? loginRefs(vaultStore.getSnapshot().items);
  const messages: ResetMailMessage[] = [];
  for (const email of emails) {
    const found = await passwordResetMailSeams.listMessages(email.address);
    for (const message of found) {
      messages.push({
        mailbox: message.mailbox.trim() || email.address,
        subject: message.subject,
        text: message.text,
      });
    }
  }
  for (const match of matchResetMail(emails, items, messages)) {
    const key = `${match.itemId}\n${match.origin}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const posted = await (source?.post ?? postRotation)(match.origin);
    if (!posted) seen.delete(key);
  }
}

function loginRefs(items: readonly VaultItem[]): ResetLoginRef[] {
  return items.flatMap((item) =>
    item.kind === "account"
      ? [
          {
            id: item.id,
            resetEmailId: item.resetEmailId,
            uris: item.uris.map((entry) => entry.uri),
          },
        ]
      : [],
  );
}

async function postRotation(origin: string): Promise<boolean> {
  try {
    const response = await hostFetch("/api/v1/rotations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        web_login_origin: origin,
        execute_now: true,
      }),
    });
    return response.ok;
  } catch {
    return false;
  }
}
