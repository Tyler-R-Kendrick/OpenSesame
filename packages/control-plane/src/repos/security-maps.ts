import type { Database, EventSealer } from "@opensesame/database";
import type { AppStores } from "../state.js";
import { DurableMap } from "./durable-map.js";
import {
  PostgresAgentInstanceStore,
  PostgresAgentStore,
} from "./legacy-agent-postgres.js";

export function installDurableSecurityMaps(
  stores: AppStores,
  db: Database,
  ttlMs: number,
  sealer: EventSealer,
): void {
  const map = <T>(
    model: string,
    secretKeys: boolean,
    ttl: number | null,
    capacity = 10_000,
  ) => new DurableMap<T>(db, model, secretKeys, ttl, capacity, sealer);
  stores.agents = new PostgresAgentStore(db);
  stores.agentInstances = new PostgresAgentInstanceStore(db);
  stores.provisionalSessions = map(
    "OpenSesame:ProvisionalSession",
    false,
    ttlMs,
  );
  stores.provisionalTokens = map("OpenSesame:ProvisionalToken", true, ttlMs);
  stores.totpSecrets = map("OpenSesame:TotpSecret", false, null);
  // Outlives the one step a code is good for; after that the step is past.
  stores.totpSteps = map("OpenSesame:TotpStep", false, 120_000);
  stores.claimApprovalAttempts = map(
    "OpenSesame:ClaimAttempt",
    false,
    86_400_000,
  );
  stores.mfaFailures = map("OpenSesame:MfaFailure", false, 86_400_000);
  stores.mfaCodes = map("OpenSesame:MfaCode", false, 300_000);
  stores.mfaCodeSends = map("OpenSesame:MfaCodeSend", false, 3_600_000);
  stores.siopLinkChallenges = map(
    "OpenSesame:SiopLinkChallenge",
    false,
    300_000,
  );
  stores.enrollmentTickets = map(
    "OpenSesame:EnrollmentTicket",
    true,
    3_600_000,
  );
  stores.claimMappings = map("OpenSesame:ClaimMapping", false, null);
  stores.hostAuthorizations = map(
    "OpenSesame:HostAuthorization",
    false,
    300_000,
    1000,
  );
}
