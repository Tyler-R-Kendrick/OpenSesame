/** Genuine configured-factor work; no helper result issues owner authority. */
import { type VaultHeader, WrongPasswordError } from "@opensesame/vault-core";
import { captureOriginalIdentityCodeData } from "../identity.js";
import {
  type FreshOwnerFactorPolicy,
  readFreshOwnerFactorPolicy,
} from "./fresh-owner-factor-policy.js";
import { disposeOriginalCommandData } from "./original-command-retirement-data.js";
import { spendRecoveryCode } from "./recovery-codes.js";
import type {
  RetiredOperationExchange,
  RetiredOperationMessage,
  RetiredSecondStepRequest,
} from "./retired-operation-exchange.js";
import { openText, openTotpSecret, totpCodeMatches } from "./unlock-methods.js";
type Remote = ReturnType<typeof captureOriginalIdentityCodeData>;
interface Attempt {
  header: VaultHeader;
  key: CryptoKey;
  policy: FreshOwnerFactorPolicy;
  check: () => void;
  failed: () => void;
}
async function sendConfiguredCode(
  attempt: Attempt,
  remote: Remote,
  message: Extract<RetiredOperationMessage, { kind: "send" }>,
) {
  try {
    if (!attempt.policy.secondSteps.includes(message.channel))
      throw new Error("That code route is not configured.");
    const record = attempt.header.unlocks?.[message.channel];
    if (!record) throw new Error("The configured code route changed.");
    const to = await openText(attempt.key, record.toWrap);
    attempt.check();
    const status = await remote.send(message.channel, to);
    attempt.check();
    message.acknowledge(status);
  } catch (cause) {
    message.reject(cause);
    throw cause;
  }
}
async function verifyConfiguredFactor(
  attempt: Attempt,
  request: RetiredSecondStepRequest,
  remote: Remote | undefined,
): Promise<VaultHeader> {
  const { header, key, policy, check, failed } = attempt;
  if (request.kind === "recovery" && policy.recoveryCodesEnrolled) {
    const record = header.unlocks?.recovery;
    if (!record) throw new Error("The recovery configuration changed.");
    const codesWrap = await spendRecoveryCode(
      key,
      record,
      request.code,
      failed,
    );
    check();
    return {
      ...header,
      unlocks: { ...header.unlocks, recovery: { ...record, codesWrap } },
    };
  }
  if (request.kind === "remote" && remote) {
    try {
      await remote.verify(request.code);
    } catch (cause) {
      failed();
      throw cause;
    }
    check();
    return header;
  }
  const gate = header.unlocks?.totp;
  if (request.kind === "totp" && policy.secondSteps.includes("totp") && gate) {
    const secret = await openTotpSecret(key, gate);
    check();
    const matches = await totpCodeMatches(
      secret,
      request.code,
      gate.digits,
      gate.period,
    );
    check();
    if (matches) return header;
  }
  failed();
  throw new WrongPasswordError("That configured authentication did not match.");
}
export async function consumeRetiredOwnerFactors<T extends object>(
  header: VaultHeader,
  key: CryptoKey,
  exchange: RetiredOperationExchange<T>,
  check: () => void,
  failed: () => void,
): Promise<VaultHeader> {
  const policy = readFreshOwnerFactorPolicy(header);
  if (!policy.secondSteps.length) return header;
  const routes = [...policy.secondSteps];
  exchange.offer(
    policy.recoveryCodesEnrolled ? [...routes, "recovery"] : routes,
  );
  const attempt = { header, key, policy, check, failed };
  let remote: Remote | undefined;
  let failure: ErrorOptions | undefined;
  try {
    for (;;) {
      const message = await exchange.next();
      check();
      if (message.kind === "complete")
        return await verifyConfiguredFactor(attempt, message.request, remote);
      remote ??= captureOriginalIdentityCodeData(check);
      await sendConfiguredCode(attempt, remote, message);
    }
  } catch (cause) {
    failure = { cause };
    throw cause;
  } finally {
    await disposeOriginalCommandData(failure, exchange.recordDrainFailure, [
      async () => await remote?.close(),
    ]);
  }
}
