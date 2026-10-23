import { sql } from "drizzle-orm";
import type { EventSealer } from "../event-seal.js";
import {
  isCurrentSecretText,
  openLegacySecretText,
  openSecretText,
  sealSecretText,
} from "../secret-seal.js";
import type { Database } from "./postgres.js";
import { sealLegacyOidc } from "./sealed-oidc-sweep.js";
import { sealLegacySessions } from "./sealed-sessions-sweep.js";

interface SecretColumn {
  table: string;
  column: string;
  id: string;
  scope: string;
  recordBound: boolean;
  bindingId?: string;
  betterAuthField?: string;
}
const COLUMNS: readonly SecretColumn[] = [
  {
    table: "organizations",
    column: "sso_client_secret",
    id: "id",
    scope: "id",
    recordBound: false,
  },
  {
    table: "org_ldap_config",
    column: "service_bind_secret",
    id: "organization_id",
    scope: "organization_id",
    recordBound: false,
  },
  {
    table: "byo_upstreams",
    column: "client_secret",
    id: "id",
    scope: "",
    recordBound: true,
  },
  {
    table: "webhook_endpoints",
    column: "secret",
    id: "id",
    scope: "principal_id",
    recordBound: true,
  },
  {
    table: "push_subscriptions",
    column: "endpoint",
    id: "id",
    scope: "principal_id",
    recordBound: true,
    bindingId: "endpoint_digest",
  },
  {
    table: "push_subscriptions",
    column: "auth_secret",
    id: "id",
    scope: "principal_id",
    recordBound: true,
    bindingId: "endpoint_digest",
  },
  ...(
    [
      ["access_token", "accessToken"],
      ["refresh_token", "refreshToken"],
      ["id_token", "idToken"],
      ["password", "password"],
    ] as const
  ).map(([column, betterAuthField]) => ({
    table: "better_auth_accounts",
    column,
    id: "id",
    scope: "user_id",
    recordBound: false,
    betterAuthField,
  })),
];

/** Bounded, restartable migration. Updates compare every value the envelope is bound to, so a concurrent rotation or ownership change is not lost. */
export async function sealLegacySecrets(
  db: Database,
  sealer: EventSealer,
  allowLegacy = true,
): Promise<number> {
  let changed = 0;
  for (const column of COLUMNS) {
    let cursor = "";
    const table = sql.identifier(column.table);
    const id = sql.identifier(column.id);
    const value = sql.identifier(column.column);
    const scope = column.scope
      ? sql.identifier(column.scope)
      : sql<string>`'deployment'`;
    const bindingId = sql.identifier(column.bindingId ?? column.id);
    for (;;) {
      const rows = await db
        .select({
          id: sql<string>`${id}`,
          value: sql<string>`${value}`,
          scope: sql<string>`${scope}`,
          bindingId: sql<string>`${bindingId}`,
          providerId: column.betterAuthField
            ? sql<string>`${sql.identifier("provider_id")}`
            : sql<string>`''`,
          accountId: column.betterAuthField
            ? sql<string>`${sql.identifier("account_id")}`
            : sql<string>`''`,
        })
        .from(sql`${table}`)
        .where(sql`${id} > ${cursor} and ${value} is not null`)
        .orderBy(sql`${id}`)
        .limit(200);
      if (rows.length === 0) break;
      for (const row of rows) {
        cursor = row.id;
        const purpose = column.betterAuthField
          ? JSON.stringify([
              "better_auth_accounts",
              row.providerId,
              row.accountId,
              column.betterAuthField,
            ])
          : column.recordBound
            ? `${column.table}.${column.column}:${row.bindingId}`
            : `${column.table}.${column.column}`;
        if (!allowLegacy) {
          openSecretText(sealer, purpose, row.scope, row.value);
          continue;
        }
        // Authenticate any existing envelope before leaving it in place.
        const plain = openLegacySecretText(
          sealer,
          purpose,
          row.scope,
          row.value,
        );
        if (isCurrentSecretText(row.value)) {
          openSecretText(sealer, purpose, row.scope, row.value);
          continue;
        }
        const sealed = sealSecretText(sealer, purpose, row.scope, plain);
        // Compare every input the envelope is bound to, not just the secret:
        // a concurrent owner/binding change must leave the row for the next
        // sweep under its new scope instead of writing a stale envelope.
        const updated = await db.execute(
          sql`update ${table} set ${value} = ${sealed}
              where ${id} = ${row.id}
                and ${value} = ${row.value}
                and ${scope} = ${row.scope}
                ${column.bindingId ? sql`and ${bindingId} = ${row.bindingId}` : sql``}
                ${column.betterAuthField ? sql`and ${sql.identifier("provider_id")} = ${row.providerId} and ${sql.identifier("account_id")} = ${row.accountId}` : sql``}
              returning ${id}`,
        );
        // Drizzle drivers expose execute() results either as an array or as
        // { rows }. Count a match from either shape; a zero-row CAS is a
        // concurrent rotation and stays unsealed for the next pass.
        const result = updated as unknown as {
          readonly rows?: readonly unknown[];
        };
        const matched = Array.isArray(updated)
          ? updated.length
          : (result.rows?.length ?? 0);
        if (matched > 0) changed += 1;
      }
    }
  }
  return (
    changed +
    (await sealLegacySessions(db, sealer, allowLegacy)) +
    (await sealLegacyOidc(db, sealer, allowLegacy))
  );
}
