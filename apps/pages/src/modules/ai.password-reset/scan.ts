/**
 * One pass of the mailbox check. Each readable mailbox a login is bound to is
 * read over JMAP for the last two hours; a message that is a reset link for
 * one of those logins is announced once in the tray. When the ceremony is
 * reachable the tray offers a reset action; only a person pressing it creates
 * the one-time correlation nonce the hand-off consumes, then the Host gets the
 * link's https origin — never the link, which carries the token.
 *
 * A mailbox no login names is not read. A mailbox that cannot be read raises
 * one notice naming it and the reason in a word; the login is never in it.
 */

import { hostFetch } from "@opensesame/app-core/lib/identity.js";
import {
  dismissNotice,
  setStatusNotice,
} from "@opensesame/app-core/lib/notices.js";
import {
  type ResetLoginRef,
  type ResetMailMessage,
  accountsBoundTo,
  autonomousPasswordResetReady,
  matchResetMail,
  resetMailboxes,
} from "@opensesame/app-core/lib/password-reset-mail.js";
import {
  LOOKBACK_MS,
  handledKey,
  isHandled,
  markHandled,
  unmarkHandled,
} from "@opensesame/app-core/lib/password-reset/handled.js";
import {
  authorizeResetHandoff,
  consumeResetHandoffAuthorization,
} from "@opensesame/app-core/lib/password-reset/handoff-authorization.js";
import {
  JmapError,
  type JmapFailure,
  type MailFetch,
  readRecentMessages,
} from "@opensesame/app-core/lib/password-reset/jmap.js";
import { adoptLegacyResetEmails } from "@opensesame/app-core/lib/password-reset/legacy-emails.js";
import { connectionOf } from "@opensesame/app-core/lib/password-reset/mailbox-connection.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import type { VaultItem } from "@opensesame/vault-core";

const EVERY_MS = 60_000;
const UNUSABLE_SERVER = "The mail server address could not be used.";

export type ScanDeps = {
  /** The capability's egress, bound to the purpose it declared. */
  fetch: MailFetch;
  now?: () => number;
  items?: () => readonly VaultItem[];
  unlocked?: () => boolean;
  handOff?: (origin: string) => Promise<boolean>;
};

function readFailure(code: JmapFailure): string {
  switch (code) {
    case "unauthorized":
      return "The mail server refused the login.";
    case "unreachable":
      return "The mail server could not be reached.";
    case "unsupported":
      return "The mail server does not answer JMAP.";
    case "malformed":
      return "The mail server answered in a way that could not be read.";
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

/** Build the check. `start` runs it on a timer for as long as the lease lasts. */
export function createPasswordResetScan(deps: ScanDeps) {
  const now = deps.now ?? Date.now;
  const items = deps.items ?? (() => vaultStore.getSnapshot().items);
  const unlocked =
    deps.unlocked ?? (() => vaultStore.getSnapshot().status === "unlocked");
  const handOff = deps.handOff ?? postRotation;
  let running = false;

  async function readMailboxes(
    all: readonly VaultItem[],
  ): Promise<ResetMailMessage[]> {
    const since = new Date(now() - LOOKBACK_MS);
    const messages: ResetMailMessage[] = [];
    for (const mailbox of resetMailboxes(all)) {
      if (!mailbox.readable) continue;
      if (accountsBoundTo(all, mailbox.id).length === 0) continue;
      const item = all.find((entry) => entry.id === mailbox.id);
      const connection = item ? connectionOf(item) : null;
      const noticeId = `password-reset-read:${mailbox.id}`;
      if (!connection) {
        // Shown as readable but not openable: a server edited outside the form.
        setStatusNotice({
          id: noticeId,
          tone: "warn",
          title: "Reset email not read",
          body: `${mailbox.name}: ${UNUSABLE_SERVER}`,
        });
        continue;
      }
      try {
        messages.push(
          ...(await readRecentMessages(connection, deps.fetch, { since })),
        );
        dismissNotice(noticeId);
      } catch (error) {
        const code = error instanceof JmapError ? error.code : "unreachable";
        setStatusNotice({
          id: noticeId,
          tone: "warn",
          title: "Reset email not read",
          body: `${mailbox.name}: ${readFailure(code)}`,
        });
      }
    }
    return messages;
  }

  async function act(all: readonly VaultItem[], messages: ResetMailMessage[]) {
    const mailboxes = resetMailboxes(all);
    const ready = await autonomousPasswordResetReady();
    for (const match of matchResetMail(mailboxes, loginRefs(all), messages)) {
      const key = await handledKey(
        match.itemId,
        match.origin,
        match.messageId ?? "",
      );
      const login = all.find((entry) => entry.id === match.itemId);
      const request = {
        itemId: match.itemId,
        origin: match.origin,
        messageId: match.messageId ?? "",
      };
      const handOffApproved = async (): Promise<boolean> => {
        if (isHandled("handedOff", key)) return false;
        if (!consumeResetHandoffAuthorization(request, now())) return false;
        markHandled("handedOff", key, now());
        if (await handOff(match.origin)) return true;
        unmarkHandled("handedOff", key);
        return false;
      };
      const awaitingApproval = ready && !isHandled("handedOff", key);
      if (!isHandled("announced", key) || awaitingApproval) {
        if (!isHandled("announced", key)) markHandled("announced", key, now());
        setStatusNotice({
          id: `password-reset-mail:${key}`,
          tone: "info",
          title: "Password reset email",
          body: `A reset message for ${login?.name || match.origin} arrived.`,
          ...(awaitingApproval
            ? {
                act: {
                  label: "Reset this password",
                  run: () => {
                    authorizeResetHandoff(request, now());
                    void handOffApproved();
                  },
                },
              }
            : undefined),
        });
      }
      if (ready && !isHandled("handedOff", key)) await handOffApproved();
    }
  }

  async function scan(): Promise<void> {
    if (running || !unlocked()) return;
    running = true;
    try {
      await adoptLegacyResetEmails(vaultStore).catch(() => 0);
      const all = items();
      await act(all, await readMailboxes(all));
    } finally {
      running = false;
    }
  }

  function start(signal: AbortSignal): void {
    const timer = setInterval(() => void scan(), EVERY_MS);
    const stop = () => clearInterval(timer);
    if (signal.aborted) {
      stop();
      return;
    }
    signal.addEventListener("abort", stop, { once: true });
    void scan();
  }

  return { scan, start };
}
