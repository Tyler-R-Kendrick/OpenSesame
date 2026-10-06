import type { CredentialItem, PasswordMethod } from "@opensesame/vault-core";
import { Link } from "react-router";
import { FieldRow } from "../../components/FieldRow.js";
import { useVault, useVaultStore } from "../../lib/vault/hooks.js";
import type { MethodRowPorts } from "./AccountMethodRows.js";
import { MethodRow } from "./MethodRow.js";

/**
 * A credential kept as an entry of its own (ADR 0179): the account it opens, or
 * none, and its values as rows, the same ones an account draws for the login
 * method it holds.
 */
export function CredentialDetail({
  item,
  ports,
}: {
  item: CredentialItem;
  ports: MethodRowPorts;
}) {
  const { items } = useVault();
  const store = useVaultStore();
  const owner = items.find(
    (candidate) =>
      candidate.kind === "account" &&
      candidate.id === item.accountId &&
      candidate.deletedAt === null,
  );
  const save = async (method: PasswordMethod) => {
    await store.saveItem({
      ...item,
      method,
      updatedAt: new Date().toISOString(),
    });
  };
  return (
    <section className="detail__group">
      <h2 className="detail__grouphead">Credential</h2>
      <FieldRow label="Account">
        {owner ? (
          <Link className="frow__value" to={`/vault/${owner.id}`}>
            {owner.name || "Untitled"}
          </Link>
        ) : (
          <span className="frow__value frow__value--muted">None</span>
        )}
      </FieldRow>
      <MethodRow
        account={{
          id: item.accountId ?? "",
          username: owner?.kind === "account" ? owner.username : "",
        }}
        method={item.method}
        methods={[item.method]}
        ports={ports}
        guide
        onSave={save}
      />
    </section>
  );
}
