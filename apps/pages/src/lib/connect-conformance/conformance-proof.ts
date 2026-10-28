import type {
  ConnectMethodKind,
  ConnectPlan,
} from "@opensesame/app-core/lib/connect-plan.js";
import type { checkConnectorToken } from "@opensesame/app-core/lib/vercel-connect-manage.js";
import { expect } from "vitest";
import { VERIFY_TARGETS } from "../../../server/connect-verify-targets.generated.mjs";
import {
  CONFORMANCE_ACCOUNT,
  type ProviderEmulator,
  type ProviderProfile,
} from "./provider-emulator.js";

export function assertTokenProof({
  plan,
  kind,
  profile,
  provider,
  providerCallsBeforeCheck,
  check,
}: {
  plan: ConnectPlan;
  kind: ConnectMethodKind;
  profile: ProviderProfile;
  provider: ProviderEmulator;
  providerCallsBeforeCheck: string[];
  check: Awaited<ReturnType<typeof checkConnectorToken>>;
}): void {
  const target =
    VERIFY_TARGETS[plan.id]?.[kind === "oauth" ? "oauth" : "apiKey"];
  if (target?.unbound || target?.proofDisabled) {
    expect(check.verified).toBeNull();
    expect(provider.log).toEqual(providerCallsBeforeCheck);
  } else if (profile.verify) {
    expect(check.verified, provider.log.join("\n")).toMatchObject({
      status: 200,
      ok: true,
    });
    if (profile.verify.accountField) {
      const conditions =
        kind === "api-key"
          ? VERIFY_TARGETS[plan.id]?.apiKey?.success
          : undefined;
      const condition = conditions?.find(
        (item) => item.field === profile.verify?.accountField,
      );
      expect(check.verified?.account).toBe(
        String(condition?.equals ?? CONFORMANCE_ACCOUNT),
      );
    }
  }
}
