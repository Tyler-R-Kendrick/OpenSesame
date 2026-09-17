import type { UnitOfWork } from "./interfaces.js";

/** Insert issuer+jti. Returns true if this replica won; false if already seen. */
export interface AgentAuthReplayRepository {
  consumeProviderAssertionReplay(
    issuer: string,
    jti: string,
    expiresAt: Date,
    uow?: UnitOfWork,
  ): Promise<boolean>;
}
