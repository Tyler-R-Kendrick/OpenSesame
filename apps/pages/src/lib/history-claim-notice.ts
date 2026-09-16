/**
 * Guest-claim bell copy when provisional Postgres history accounts exist.
 */

import { listHistoryAccounts } from "./history-backup-idb.js";
import { dismissNotice, listNotices, pushNotice } from "./notices.js";

const GUEST_NOTICE_TITLE = "Claim this guest session";
const GUEST_NOTICE_BODY =
  "You skipped registered sign-in. Sign in with a trusted account to attach it to this principal — the id stays the same.";

export { GUEST_NOTICE_BODY, GUEST_NOTICE_TITLE };

export async function guestClaimNoticeBody(
  baseBody: string = GUEST_NOTICE_BODY,
): Promise<string> {
  let accounts: Awaited<ReturnType<typeof listHistoryAccounts>> = [];
  try {
    accounts = await listHistoryAccounts();
  } catch {
    accounts = [];
  }
  const provisional = accounts.filter(
    (row) => row.claimState === "provisional",
  );
  if (provisional.length === 0) return baseBody;
  const names = provisional
    .map((row) => row.providerId)
    .filter((id, index, all) => all.indexOf(id) === index)
    .map((id) => {
      if (id === "supabase") return "Supabase";
      if (id === "neon") return "Neon";
      if (id === "postgresql") return "PostgreSQL";
      return id;
    });
  return `${baseBody} Your ${names.join(", ")} backup account${provisional.length === 1 ? "" : "s"} stay provisional until you claim — history already written there transfers with the principal.`;
}

/**
 * Raise (or refresh) the guest-claim bell when provisional Postgres history
 * accounts exist. Works with or without an Identity API — the visible road is
 * always "Sign in to claim" in the notifications sheet.
 */
export async function ensureHistoryClaimNotice(): Promise<void> {
  const body = await guestClaimNoticeBody();
  if (body === GUEST_NOTICE_BODY) return;
  for (const notice of listNotices()) {
    if (notice.kind === "guest_claim") dismissNotice(notice.id);
  }
  pushNotice({
    kind: "guest_claim",
    title: GUEST_NOTICE_TITLE,
    body,
  });
}
