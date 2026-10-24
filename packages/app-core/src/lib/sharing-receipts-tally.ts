/**
 * Wrong-code tally on the one drop-refused receipt (flood control stays in
 * `sharing-receipts.ts`). The count only rises. A later note does not append
 * a second line.
 */

import { redactAuditMetadata } from "@opensesame/audit/redact";
import { isNumber } from "@opensesame/os-domain";
import { patchActivityCount } from "./activity-log.js";
import {
  MAX_BYTES,
  TRAIL_PATH,
  readStore,
  writeStore,
} from "./device-receipts-store.js";
import { withLocalAccessLedgerLock } from "./local-access-ledger-lock.js";
import { notifyLocalIamChange } from "./local-iam-events.js";

const tallies = new Map<string, number>();

export type RefusalPlan =
  | { readonly action: "skip" }
  | {
      readonly action: "write";
      readonly summary: string;
      readonly count?: number;
    }
  | {
      readonly action: "revise";
      readonly summary: string;
      readonly count: number;
    };

/** Words the sender sees for a wrong-code tally. */
export function refusalWords(count: number): string {
  const noun = count === 1 ? "code" : "codes";
  return `Refused · ${count} wrong ${noun}`;
}

export function resetRefusalTalliesForTest(): void {
  tallies.clear();
}

function explicitCount(wrongCodes: number | undefined): number | null {
  if (
    wrongCodes === undefined ||
    !Number.isInteger(wrongCodes) ||
    wrongCodes < 1
  ) {
    return null;
  }
  return wrongCodes;
}

/**
 * What the one refused receipt should do. `alreadyNoted` is the dedupe set
 * in `sharing-receipts.ts` — this function does not append.
 */
export function planDropRefusal(
  claimId: string | null,
  tomb: string | null,
  wrongCodes: number | undefined,
  alreadyNoted: boolean,
): RefusalPlan {
  if (!claimId || !tomb) return { action: "skip" };
  const key = `${tomb}:${claimId}`;
  const explicit = explicitCount(wrongCodes);
  const prior = tallies.get(key) ?? 0;
  if (explicit === null) {
    if (alreadyNoted) return { action: "skip" };
    return { action: "write", summary: "Drop refused" };
  }
  const next = Math.max(prior, explicit);
  tallies.set(key, next);
  const summary = refusalWords(next);
  if (!alreadyNoted) return { action: "write", summary, count: next };
  if (next <= prior) return { action: "skip" };
  return { action: "revise", summary, count: next };
}

async function patchReceiptCount(
  tomb: string,
  claimId: string,
  count: number,
): Promise<void> {
  const wrote = await withLocalAccessLedgerLock(
    tomb,
    "receipts",
    TRAIL_PATH,
    MAX_BYTES * 2,
    async () => {
      const trail = await readStore(tomb, TRAIL_PATH);
      let changed = false;
      const next = trail.map((row) => {
        if (
          row.eventType !== "access.drop.refused" ||
          row.targetId !== claimId
        ) {
          return row;
        }
        const prior = row.metadata.count;
        if (isNumber(prior) && prior >= count) return row;
        changed = true;
        return {
          ...row,
          metadata: redactAuditMetadata({ ...row.metadata, count }),
        };
      });
      if (!changed) return false;
      await writeStore(tomb, TRAIL_PATH, next);
      return true;
    },
  );
  if (wrote) notifyLocalIamChange();
}

/** Raise the count on the receipt and the activity line already written. */
export async function reviseDropRefusal(
  tomb: string,
  claimId: string,
  count: number,
  summary: string,
): Promise<void> {
  // Each trail is sealed on its own. One that cannot be opened must not
  // keep the other from recording the higher count.
  try {
    await patchActivityCount(
      tomb,
      "vault.drop.refused",
      claimId,
      summary,
      count,
    );
  } catch {
    // The activity line can fail without undoing the refusal.
  }
  try {
    await patchReceiptCount(tomb, claimId, count);
  } catch {
    // The receipt can fail without undoing the refusal.
  }
}
