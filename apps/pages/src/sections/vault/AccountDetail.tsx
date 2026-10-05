import type { AccountItem, PasswordMethod } from "@opensesame/vault-core";
import { CopyButton, FieldRow } from "../../components/FieldRow.js";
import {
  type PepperAskFn,
  usePepperPrompt,
} from "../../components/PepperPrompt.js";
import { useVaultStore } from "../../lib/vault/hooks.js";
import {
  ApiKeyRows,
  AuthenticatorRows,
  OAuthRows,
  TokenRows,
} from "./AccountMethodRows.js";
import { AccountPasswordRow } from "./AccountPasswordRow.js";
import { AccountWebsiteRows } from "./AccountWebsiteRows.js";
import { methodTitle } from "./MethodPicker.js";

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

type RowPorts = Parameters<typeof ApiKeyRows>[0]["ports"];

/** One row group per login method, in the account's order. */
function MethodRows({
  item,
  ports,
  ask,
  onSave,
}: {
  item: AccountItem;
  ports: RowPorts;
  ask: PepperAskFn;
  onSave: (method: PasswordMethod) => Promise<void>;
}) {
  const { copied, failed, copy } = ports;
  return item.methods.map((method) => {
    switch (method.type) {
      case "password":
        return (
          <AccountPasswordRow
            key={method.id}
            item={item}
            method={method}
            title={methodTitle(item.methods, method)}
            ask={ask}
            copying={{ copied, failed, copy }}
            onSave={onSave}
          />
        );
      case "api-key":
        return <ApiKeyRows key={method.id} method={method} ports={ports} />;
      case "token":
        return <TokenRows key={method.id} method={method} ports={ports} />;
      case "oauth":
        return <OAuthRows key={method.id} method={method} ports={ports} />;
      case "authenticator":
        return (
          <AuthenticatorRows key={method.id} method={method} ports={ports} />
        );
    }
  });
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
  const store = useVaultStore();
  const pepper = usePepperPrompt();
  const ports = { name: item.name, revealed, toggle, copied, failed, copy };
  const firstPassword = item.methods.find(
    (method): method is PasswordMethod => method.type === "password",
  );

  const saveMethod = async (next: PasswordMethod) => {
    await store.saveItem({
      ...item,
      updatedAt: new Date().toISOString(),
      methods: item.methods.map((method) =>
        method.id === next.id ? next : method,
      ),
    });
  };

  return (
    <>
      {pepper.element}
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
              />
            }
          >
            <span className="frow__value">{item.username}</span>
          </FieldRow>
        ) : null}
        <MethodRows
          item={item}
          ports={ports}
          ask={pepper.ask}
          onSave={saveMethod}
        />
      </section>

      <AccountWebsiteRows item={item} copying={{ copied, failed, copy }} />

      {firstPassword ? (
        <p className="hint">
          Password last changed {formatDate(firstPassword.changedAt)}.
        </p>
      ) : null}
    </>
  );
}
