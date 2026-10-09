import type { UpstreamAuthDatabase } from "@opensesame/auth-upstream";
import {
  type EventSealer,
  openSecretText,
  sealSecretText,
} from "@opensesame/database";

/** Every durable authentication adapter receives an owner-bound secret codec. */
export function withAccountSecretCodec(
  database: UpstreamAuthDatabase | undefined,
  sealer: EventSealer,
): UpstreamAuthDatabase | undefined {
  if (!database) return undefined;
  return {
    ...database,
    accountSecrets: database.accountSecrets ?? {
      lookup: (purpose, value) => sealer.lookupToken(purpose, value),
      seal: (purpose, owner, value) =>
        sealSecretText(sealer, purpose, owner, value),
      open: (purpose, owner, value) =>
        openSecretText(sealer, purpose, owner, value),
    },
  };
}
