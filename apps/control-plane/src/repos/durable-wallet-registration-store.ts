/**
 * Durable launcher-registration store (ADR 0119 / ADR 0125).
 */

import type { Database } from "@opensesame/database";
import type {
  WalletRegistration,
  WalletRegistrationInput,
  WalletRegistrationStore,
} from "@opensesame/wallet";
import { WalletRegistrationConflictError } from "@opensesame/wallet";
import { DurableMap } from "./durable-map.js";

export class DurableWalletRegistrationStore implements WalletRegistrationStore {
  private readonly rows: DurableMap<WalletRegistration>;
  private readonly clock: () => Date;

  constructor(db: Database, clock: () => Date) {
    this.rows = new DurableMap(
      db,
      "OpenSesame:WalletRegistration",
      false,
      null,
    );
    this.clock = clock;
  }

  async create(input: WalletRegistrationInput): Promise<WalletRegistration> {
    if (await this.rows.get(input.registrationId)) {
      throw new WalletRegistrationConflictError(input.registrationId);
    }
    const row: WalletRegistration = {
      registrationId: input.registrationId,
      state: "active",
      ownerPrincipalId: input.ownerPrincipalId,
      passId: input.passId,
      createdAt: this.clock(),
    };
    await this.rows.set(row.registrationId, row);
    return { ...row };
  }

  async get(registrationId: string): Promise<WalletRegistration | null> {
    const row = await this.rows.get(registrationId);
    return row ? { ...row } : null;
  }

  async list(ownerPrincipalId: string): Promise<readonly WalletRegistration[]> {
    return (await this.rows.values())
      .filter((row) => row.ownerPrincipalId === ownerPrincipalId)
      .map((row) => ({ ...row }));
  }

  async disable(registrationId: string): Promise<WalletRegistration | null> {
    const row = await this.rows.get(registrationId);
    if (!row) return null;
    if (row.state === "disabled") return { ...row };
    const disabled: WalletRegistration = {
      ...row,
      state: "disabled",
      disabledAt: this.clock(),
    };
    await this.rows.set(registrationId, disabled);
    return { ...disabled };
  }
}
