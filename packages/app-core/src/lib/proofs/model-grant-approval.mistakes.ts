/**
 * Mistakes the type checker must keep refusing (ADR 0178, ADR 0189).
 *
 * Each `@ts-expect-error` is a way to mint a root model key without the
 * approval of the exact grant it carries. `tsc` fails the build if one starts
 * to compile. Nothing in this file runs.
 */

import { name } from "@gdp-ts/core";
import type { ModelKeyBroker } from "../model-keys/broker.js";
import type { ModelGrantDraft } from "../model-keys/root.js";
import {
  type ModelGrantApprovalEvidence,
  proveModelGrantApproved,
} from "./model-grant-approval.js";

export async function modelGrantMistakes(
  broker: ModelKeyBroker,
  draftA: ModelGrantDraft,
  draftB: ModelGrantDraft,
  evidence: ModelGrantApprovalEvidence,
  sha256: (text: string) => Promise<string>,
): Promise<void> {
  await name(draftA, draftB, async (a, b) => {
    const verdictA = await proveModelGrantApproved(a, evidence, 0, sha256);
    if (!verdictA.ok) return;

    // The honest path compiles.
    await broker.issueRoot(a, verdictA.proof);

    // @ts-expect-error — an approval of draft A is not an approval of draft B.
    await broker.issueRoot(b, verdictA.proof);

    // @ts-expect-error — no approval at all.
    await broker.issueRoot(a);

    // @ts-expect-error — a bare draft is not a named one: the proof is about a name.
    await broker.issueRoot(draftA, verdictA.proof);

    // @ts-expect-error — a verdict is not a proof; a refusal has no proof to hand over.
    await broker.issueRoot(a, verdictA);
  });
}
