import type { PendingRequest } from "@opensesame/app-core/lib/cli-app-integration/pending-request.js";
import type { VaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { WrongPasswordError } from "@opensesame/vault-core";
import { respondCliIntegration } from "./cli-daemon-client.js";

export async function approveCliIntegrationRequest(
  store: VaultStore,
  request: PendingRequest,
  opts: { canPasskey: boolean; canPin: boolean; pin: string },
): Promise<void> {
  const stepUp = await import("./cli-step-up.js");
  if (opts.canPasskey) await stepUp.confirmPasskeyStepUpForCli(store, undefined);
  else if (opts.canPin) await stepUp.confirmPinStepUpForCli(store, opts.pin);
  else throw new Error("Enroll a passkey or PIN in Settings › Security.");
  const ok = await respondCliIntegration(
    request.requestId,
    request.terminalSessionId,
    "approve",
  );
  if (!ok) throw new Error("CLI integration could not reach the daemon.");
}

export async function denyCliIntegrationRequest(
  request: PendingRequest,
): Promise<void> {
  const ok = await respondCliIntegration(
    request.requestId,
    request.terminalSessionId,
    "deny",
  );
  if (!ok) throw new Error("CLI integration could not reach the daemon.");
}

export function cliAuthorizeErrorMessage(cause: unknown): string {
  if (cause instanceof WrongPasswordError) return cause.message;
  if (cause instanceof Error) return cause.message;
  return "Authorization was not completed.";
}
