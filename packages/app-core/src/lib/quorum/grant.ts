/**
 * A standing share the owner's circle approved while the owner was away
 * (ADR 0186): the `grant-access` operation, carried out.
 *
 * The share that is written is the one inside the approved request, field for
 * field. This function takes no share of its own, so there is nothing for a
 * caller to change between what the guardians read and what gets written:
 * displayed == approved == executed.
 *
 * Authority is the `QuorumApproved` proof (`proofs/quorum-approved.ts`),
 * minted from the ledger's verdict. A quorum can grant a person access; it
 * cannot grant an agent or an application, which stay behind the owner's own
 * approval (`local-share-grants-approvals`).
 */

import { name } from "@gdp-ts/core";
import { LocalDirectoryError, readLocalDirectory } from "../local-directory.js";
import {
  type LocalShare,
  createLocalShareAs,
  validateShareInput,
} from "../local-share-grants.js";
import { proveQuorumApproved } from "../proofs/quorum-approved.js";
import type { QuorumLedger } from "./ledger.js";
import type { Grant } from "./types.js";

export class QuorumGrantError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "QuorumGrantError";
  }
}

/**
 * Whether the share ledger would write this grant: a policy the resource kind
 * allows, a duration it offers. Ask before a request is raised, so guardians
 * are never shown a grant that could not be carried out.
 */
export function assertGrantWritable(grant: Grant): void {
  try {
    validateShareInput(grant, false);
  } catch (error) {
    if (error instanceof LocalDirectoryError) {
      throw new QuorumGrantError("invalid_grant", error.message);
    }
    throw error;
  }
}

export async function grantFromQuorum(input: {
  tomb: string;
  ledger: QuorumLedger;
  now?: number;
}): Promise<LocalShare[]> {
  const { ledger } = input;
  const grant = ledger.request.grant;
  if (!grant) {
    throw new QuorumGrantError("no_grant", "this request carries no grant");
  }
  assertGrantWritable(grant);
  return name(input.tomb, async (named) => {
    const proved = proveQuorumApproved(
      named,
      ledger.verdict(),
      input.now ?? Date.now(),
    );
    if (!proved.ok) throw new QuorumGrantError(proved.code, proved.message);
    const directory = await readLocalDirectory(named.value);
    const entry = directory.entries.find((row) => row.id === grant.principalId);
    if (entry?.kind !== "person") {
      throw new QuorumGrantError(
        "principal",
        "a quorum grants access to a person; agents and applications need the owner's own approval",
      );
    }
    if (!ledger.claimExecution()) {
      throw new QuorumGrantError(
        "executed",
        "this grant was already carried out",
      );
    }
    try {
      return await createLocalShareAs(named, grant, proved.proof);
    } catch (error) {
      // Nothing was written: the approval stays usable for another try.
      ledger.releaseExecution();
      if (error instanceof LocalDirectoryError) {
        throw new QuorumGrantError("refused", error.message);
      }
      throw error;
    }
  });
}
