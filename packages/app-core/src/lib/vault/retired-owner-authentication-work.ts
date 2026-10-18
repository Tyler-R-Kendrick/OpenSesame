/** Original primary/factor authentication and physical transaction; private Store owns issuance. */

import { sessionRootDigestFromKey } from "../duress/store/vault-session-digest.js";
import { readPagesRetiredCredentialHeader } from "../retired-credentials/context-v2-header.js";
import {
  deriveRetiredCredentialContextV2,
  encodeRetiredCredentialContextV2,
} from "../retired-credentials/context-v2.js";
import { verifyHumanAuthenticationData } from "../retired-credentials/human-authentication-data.js";

import { deriveCapturedOwnerPrimaryData } from "./captured-owner-primary-data.js";
import { verifyOriginalUnlockPolicy } from "./original-unlock-policy-proof.js";

import { runRetiredManagementEffects } from "./retired-management-effects.js";
import type { RetiredCommand } from "./retired-operation-exchange.js";
import { captureOriginalDuressCollisionData } from "./retired-owner-duress.js";
import { consumeRetiredOwnerFactors } from "./retired-owner-factors.js";
import { publishRetiredOwnerHeader } from "./retired-owner-header.js";

import type {
  RetiredOwnerAuthenticatedData,
  RetiredOwnerAuthenticationInput,
} from "./retired-owner-operation.js";
export async function performRetiredOwnerAuthentication<T extends object>(
  work: Readonly<{
    input: RetiredOwnerAuthenticationInput<T>;
    resources: RetiredOwnerAuthenticatedData["resources"];
    readers: RetiredOwnerAuthenticatedData["readers"];
    effect: (data: RetiredOwnerAuthenticatedData) => Promise<T>;
  }>,
) {
  const { input, resources, readers, effect } = work;
  const check = resources.check;
  let snapshot = await readers.auth.read();
  check();
  if (!snapshot.header || !snapshot.body)
    throw new Error("Original human vault is incomplete.");
  let header = readPagesRetiredCredentialHeader(snapshot.header);
  const primary = await deriveCapturedOwnerPrimaryData(
    header,
    input.primary,
    check,
    input.failed,
    input.exchange.controller.signal,
  );
  try {
    check();
    await verifyOriginalUnlockPolicy(header, primary.raw, check);
    await verifyHumanAuthenticationData(
      input.tomb,
      snapshot.header,
      snapshot.body,
      resources.auth.bodyFormat,
      primary.raw,
    );
    check();
    const factored = await consumeRetiredOwnerFactors(
      header,
      primary.key,
      input.exchange,
      check,
      input.failed,
    );
    check();
    const bound = await publishRetiredOwnerHeader(
      snapshot,
      header,
      factored,
      primary.raw,
      readers.publication,
      check,
      input.headerChanged,
    );
    header = bound.header;
    snapshot = bound.snapshot;
    await verifyOriginalUnlockPolicy(header, primary.raw, check);
    const current = await readers.auth.read();
    check();
    if (current.header !== snapshot.header || current.body !== snapshot.body)
      throw new Error("Original authentication snapshot changed.");
    const context = encodeRetiredCredentialContextV2(
      await deriveRetiredCredentialContextV2(input.tomb, snapshot.header),
    );
    const root = await sessionRootDigestFromKey(primary.key, false);
    check();
    if (!root) throw new Error("Original root commitment is unavailable.");
    const authenticated = {
      resources,
      readers,
      snapshot,
      header,
      raw: primary.raw,
      key: primary.key,
      rootCommitment: root,
      contextWire: context,
      check,
    } satisfies RetiredOwnerAuthenticatedData;
    const result = await effect(authenticated);
    const final = await readers.auth.read();
    if (final.header !== snapshot.header || final.body !== snapshot.body)
      throw new Error("Original authentication changed before completion.");
    check();
    return result;
  } finally {
    primary.raw.fill(0);
  }
}
export async function performRetiredOwnerManagement(
  data: RetiredOwnerAuthenticatedData,
  command: RetiredCommand,
) {
  const duress = await captureOriginalDuressCollisionData(
    data.readers.device,
    data.check,
  );
  return runRetiredManagementEffects({
    resources: data.resources,
    device: data.readers.device,
    snapshot: data.snapshot,
    header: data.header,
    bodyFormat: data.resources.auth.bodyFormat,
    rootCommitment: data.rootCommitment,
    identity: data.readers.identity,
    contextWire: data.contextWire,
    command,
    refuseDuress: duress.refuse,
    revalidateDuress: duress.revalidate,
  });
}
