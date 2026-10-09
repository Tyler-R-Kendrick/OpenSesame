import { updateLocalAccountPasswordMethod } from "@opensesame/app-core/lib/vault/account-password-write.js";
import {
  type AccountItem,
  type PasswordMethod,
  passwordMethod,
} from "@opensesame/vault-core";
import { CopyButton, FieldRow } from "../../components/FieldRow.js";
import { useVault } from "../../lib/vault/hooks.js";
import { useGuideTarget } from "../../tutorial/registry/react.jsx";
import type { MethodRowPorts } from "./AccountMethodRows.js";
import { AccountWebsiteRows } from "./AccountWebsiteRows.js";
import { MethodRow } from "./MethodRow.js";

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

type Ports = {
  revealed: Set<string>;
  toggle: (key: string) => void;
  copied: string | null;
  failed: string | null;
  copy: (key: string, value: string) => Promise<void>;
};

/** One row group per login method, in the account's order. */
function MethodRows({
  item,
  ports,
  onSave,
}: {
  item: AccountItem;
  ports: MethodRowPorts;
  onSave: (method: PasswordMethod) => Promise<void>;
}) {
  // The tutorials point at the first password's copy key, one target.
  const firstPassword = passwordMethod(item);
  return item.methods.map((method) => (
    <MethodRow
      key={method.id}
      account={item}
      method={method}
      methods={item.methods}
      ports={ports}
      guide={method === firstPassword}
      onSave={onSave}
    />
  ));
}

/** An account: who it is, one row group per login method, and the sites it lives at. */
export function AccountDetail({
  item,
  revealed,
  toggle,
  copied,
  failed,
  copy,
}: { item: AccountItem } & Ports) {
  const { tomb } = useVault();
  const usernameRef = useGuideTarget<HTMLButtonElement>("item.copy-username");
  const ports = { name: item.name, revealed, toggle, copied, failed, copy };
  const firstPassword = item.methods.find(
    (method): method is PasswordMethod => method.type === "password",
  );
  const passwordChanged = firstPassword
    ? formatDate(firstPassword.changedAt)
    : null;

  const saveMethod = async (next: PasswordMethod) => {
    try {
      if (!tomb) throw new Error("The vault is unavailable.");
      await updateLocalAccountPasswordMethod(tomb, item, next);
    } catch {
      throw new Error(
        "Password write is unverified. Do not retry automatically.",
      );
    }
  };

  return (
    <>
      <section className="detail__group">
        <h2 className="detail__grouphead">Credentials</h2>
        {item.username ? (
          <FieldRow
            label="Username / ID"
            actions={
              <CopyButton
                value={item.username}
                label="username"
                fieldKey="username"
                copied={copied}
                failed={failed}
                onCopy={copy}
                guideRef={usernameRef}
              />
            }
          >
            <span className="frow__value">{item.username}</span>
          </FieldRow>
        ) : null}
        <MethodRows item={item} ports={ports} onSave={saveMethod} />
      </section>

      <AccountWebsiteRows item={item} copying={{ copied, failed, copy }} />

      {passwordChanged && passwordChanged !== formatDate(item.updatedAt) ? (
        <p className="hint">Password last changed {passwordChanged}.</p>
      ) : null}
    </>
  );
}
