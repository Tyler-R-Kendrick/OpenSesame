import type { Database } from "@opensesame/database";
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
): void {
  stores.agents = new PostgresAgentStore(db);
  stores.agentInstances = new PostgresAgentInstanceStore(db);
  stores.provisionalSessions = new DurableMap(
    db,
    "OpenSesame:ProvisionalSession",
    false,
    ttlMs,
  );
  stores.provisionalTokens = new DurableMap(
    db,
    "OpenSesame:ProvisionalToken",
    true,
    ttlMs,
  );
  stores.totpSecrets = new DurableMap(db, "OpenSesame:TotpSecret", false, null);
  // Outlives the one step a code is good for; after that the step is past.
  stores.totpSteps = new DurableMap(db, "OpenSesame:TotpStep", false, 120_000);
  stores.claimApprovalAttempts = new DurableMap(
    db,
    "OpenSesame:ClaimAttempt",
    false,
    86_400_000,
  );
  stores.mfaFailures = new DurableMap(
    db,
    "OpenSesame:MfaFailure",
    false,
    86_400_000,
  );
  stores.mfaCodes = new DurableMap(db, "OpenSesame:MfaCode", false, 300_000);
  stores.mfaCodeSends = new DurableMap(
    db,
    "OpenSesame:MfaCodeSend",
    false,
    3_600_000,
  );
  stores.siopLinkChallenges = new DurableMap(
    db,
    "OpenSesame:SiopLinkChallenge",
    false,
    300_000,
  );
  stores.enrollmentTickets = new DurableMap(
    db,
    "OpenSesame:EnrollmentTicket",
    true,
    3_600_000,
  );
  stores.claimMappings = new DurableMap(
    db,
    "OpenSesame:ClaimMapping",
    false,
    null,
  );
  stores.hostAuthorizations = new DurableMap(
    db,
    "OpenSesame:HostAuthorization",
    false,
    300_000,
    1000,
  );
}
