/** Shared helpers for SOPS engine tests: synthetic identities and permits. */

import * as age from "age-encryption";
import type { SopsFormat } from "./document.js";
import { SopsEngine, type VerifiedDocument } from "./engine.js";
import { HandleRegistry } from "./handles.js";
import {
  type EncryptionPlan,
  type ExecutionPermit,
  planDigest,
  planFromRecipients,
} from "./plan.js";
import type { SopsPolicy } from "./selectors.js";

export type TestIdentity = { identity: string; recipient: string };

export async function newIdentity(): Promise<TestIdentity> {
  const identity = await age.generateX25519Identity();
  return { identity, recipient: await age.identityToRecipient(identity) };
}

/** `count` fresh identities, addressed without optional-chaining noise. */
export async function newIdentities(
  count: number,
): Promise<(index: number) => TestIdentity> {
  const list: TestIdentity[] = [];
  for (let index = 0; index < count; index += 1) list.push(await newIdentity());
  return (index) => {
    const found = list[index];
    if (!found) throw new Error(`no test identity ${index}`);
    return found;
  };
}

export class TestSession {
  generation = 0;
  readonly engine = new SopsEngine(
    new HandleRegistry<VerifiedDocument>(() => this.generation),
  );

  permit(digest = "", vaultScope: string | null = null): ExecutionPermit {
    return {
      scope: {
        operationId: "op",
        documentGeneration: 1,
        sessionGeneration: this.generation,
        vaultScope,
      },
      approvedPlanDigest: digest,
      network: "forbidden",
    };
  }

  async plan(
    format: SopsFormat,
    groups: readonly (readonly string[])[],
    extra?: { shamirThreshold?: number; policy?: Partial<SopsPolicy> },
  ): Promise<{ plan: EncryptionPlan; permit: ExecutionPermit }> {
    const plan = planFromRecipients({ format, groups, ...extra });
    return { plan, permit: this.permit(await planDigest(plan)) };
  }
}

export const NEVER: AbortSignal = new AbortController().signal;
