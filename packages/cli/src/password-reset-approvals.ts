import type { ResetAction, ResetRun } from "@opensesame/cua-password-reset";
import type { AuthorityGrant } from "@opensesame/os-domain";
import type { LoadedResetConfiguration } from "./password-reset-config.js";
import type { PasswordResetCommand } from "./password-reset-parse.js";

export type ResetSharedItem = Readonly<{
  id: string;
  name: string;
  origins: readonly string[];
}>;

export type ResetApproval = {
  grant: AuthorityGrant;
  items?: readonly ResetSharedItem[];
};

export interface ResetApprovalSession {
  approve(
    action: ResetAction,
    run: ResetRun,
    loaded: LoadedResetConfiguration,
  ): Promise<ResetApproval>;
  status(
    run: ResetRun,
    action: ResetAction,
    status: "takeover_requested",
  ): Promise<void>;
  close(): Promise<void>;
}

export async function openResetApprovals(
  _command: PasswordResetCommand,
): Promise<ResetApprovalSession> {
  throw new Error(
    "Live-session approval requires the reset client integration",
  );
}
