import { loginWebsiteLink } from "@opensesame/app-core/lib/vault/website-pattern.js";
import {
  type AccountItem,
  type LoginMethod,
  type PasswordMethod,
  hostOf,
} from "@opensesame/vault-core";
import { CopyButton, FieldRow } from "../../components/FieldRow.js";
import { IconExternal } from "../../components/Icons.js";
import { usePepperPrompt } from "../../components/PepperPrompt.js";
import { useVaultStore } from "../../lib/vault/hooks.js";
import {
  ApiKeyRows,
  AuthenticatorRows,
  OAuthRows,
  TokenRows,
} from "./AccountMethodRows.js";
import { AccountPasswordRow } from "./AccountPasswordRow.js";
import { METHOD_LABELS } from "./MethodPicker.js";

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function titleOf(methods: readonly LoginMethod[], method: LoginMethod): string {
  const same = methods.filter((entry) => entry.type === method.type);
  const label = METHOD_LABELS[method.type];
  return same.length > 1 ? `${label} ${same.indexOf(method) + 1}` : label;
}

type Ports = {
  revealed: Set<string>;
  toggle: (key: string) => void;
  copied: string | null;
  failed: string | null;
  copy: (key: string, value: string) => Promise<void>;
};

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
        {item.methods.map((method) => {
          switch (method.type) {
            case "password":
              return (
                <AccountPasswordRow
                  key={method.id}
                  item={item}
                  method={method}
                  title={titleOf(item.methods, method)}
                  ask={pepper.ask}
                  copying={{ copied, failed, copy }}
                  onSave={saveMethod}
                />
              );
            case "api-key":
              return (
                <ApiKeyRows key={method.id} method={method} ports={ports} />
              );
            case "token":
              return (
                <TokenRows key={method.id} method={method} ports={ports} />
              );
            case "oauth":
              return (
                <OAuthRows key={method.id} method={method} ports={ports} />
              );
            case "authenticator":
              return (
                <AuthenticatorRows
                  key={method.id}
                  method={method}
                  ports={ports}
                />
              );
          }
        })}
      </section>

      {item.uris.length > 0 ? (
        <section className="detail__group">
          <h2 className="detail__grouphead">Websites</h2>
          {item.uris.map((uri) => {
            const href = loginWebsiteLink(uri);
            return (
              <FieldRow
                key={uri.id}
                label={`Match: ${uri.match}`}
                actions={
                  <>
                    {href ? (
                      <a
                        className="icon-btn"
                        href={href}
                        target="_blank"
                        rel="noreferrer noopener"
                        aria-label={`Open ${hostOf(uri.uri) || uri.uri}`}
                        title="Open in a new tab"
                      >
                        <IconExternal size={17} />
                      </a>
                    ) : null}
                    <CopyButton
                      value={uri.uri}
                      label="address"
                      fieldKey={`uri-${uri.id}`}
                      copied={copied}
                      failed={failed}
                      onCopy={copy}
                    />
                  </>
                }
              >
                <span className="frow__value">{uri.uri}</span>
              </FieldRow>
            );
          })}
        </section>
      ) : null}

      {firstPassword ? (
        <p className="hint">
          Password last changed {formatDate(firstPassword.changedAt)}.
        </p>
      ) : null}
    </>
  );
}
