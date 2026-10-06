import { isPackOn } from "@opensesame/app-core/lib/type-packs/state.js";
import {
  type AccountItem,
  LOGIN_METHOD_TYPES,
  type LoginMethod,
  type LoginMethodType,
  credentialTypeId,
} from "@opensesame/vault-core";
import { useEffect, useRef, useState } from "react";
import { usePackSnapshot } from "../../bindings/type-packs.js";
import { IconPlus } from "../../components/Icons.js";
import { MethodPicker, methodTitle, newMethod } from "./MethodPicker.js";
import {
  ApiKeyLines,
  AuthenticatorLines,
  OAuthLines,
  TokenLines,
} from "./OtherMethodEditors.js";
import { PasswordMethodEditor } from "./PasswordMethodEditor.js";

/** One login method's lines: each value on a line of its own, the × on the first. */
function MethodLines({
  account,
  method,
  liveRoll,
  onReplace,
  onRemove,
}: {
  account: AccountItem;
  method: LoginMethod;
  liveRoll: boolean;
  onReplace: (next: LoginMethod) => void;
  onRemove: (method: LoginMethod) => void;
}) {
  const title = methodTitle(account.methods, method);
  const lines = {
    methods: account.methods,
    title,
    onRemove: () => onRemove(method),
  };
  return (
    <fieldset
      className="method"
      aria-label={`${title} method`}
      data-method={method.id}
    >
      {method.type === "password" ? (
        <PasswordMethodEditor
          account={account}
          method={method}
          liveRoll={liveRoll}
          onEdit={onReplace}
          onRemove={lines.onRemove}
        />
      ) : method.type === "api-key" ? (
        <ApiKeyLines {...lines} method={method} onChange={onReplace} />
      ) : method.type === "token" ? (
        <TokenLines {...lines} method={method} onChange={onReplace} />
      ) : method.type === "oauth" ? (
        <OAuthLines {...lines} method={method} onChange={onReplace} />
      ) : (
        <AuthenticatorLines {...lines} method={method} onChange={onReplace} />
      )}
    </fieldset>
  );
}

/**
 * The account's login methods: a heading whose `+` opens the type choice, then
 * each method's lines in order. An account may hold none, so every one can go.
 */
export function AccountMethods({
  account,
  liveRoll,
  onMethods,
}: {
  account: AccountItem;
  liveRoll: boolean;
  onMethods: (methods: LoginMethod[]) => void;
}) {
  const [picking, setPicking] = useState(false);
  const [added, setAdded] = useState<string | null>(null);
  // Only the credential types this vault has switched on may be added; the
  // ones its accounts already hold are on by being held (ADR 0165, ADR 0177).
  const packs = usePackSnapshot();
  const types = LOGIN_METHOD_TYPES.filter((type) =>
    isPackOn(credentialTypeId(type), packs),
  );
  const opener = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const { methods } = account;

  useEffect(() => {
    if (added === null) return;
    const blocks = list.current?.querySelectorAll<HTMLElement>("[data-method]");
    for (const candidate of blocks ?? []) {
      if (candidate.dataset.method !== added) continue;
      candidate.querySelector<HTMLElement>("input, select")?.focus();
    }
    setAdded(null);
  }, [added]);

  const replace = (next: LoginMethod) =>
    onMethods(methods.map((entry) => (entry.id === next.id ? next : entry)));
  const add = (type: LoginMethodType) => {
    const made = newMethod(account, type);
    onMethods([...methods, made]);
    setPicking(false);
    setAdded(made.id);
  };
  const remove = (method: LoginMethod) => {
    onMethods(methods.filter((entry) => entry.id !== method.id));
  };

  return (
    <>
      <div className="field method__group">
        <span className="label editor__grouplabel">
          Login methods
          {types.length > 0 ? (
            <button
              ref={opener}
              type="button"
              className="icon-btn icon-btn--sm"
              aria-label="Add login method"
              title="Add login method"
              aria-expanded={picking}
              onClick={() => setPicking((open) => !open)}
            >
              <IconPlus size={15} />
            </button>
          ) : null}
        </span>
        {picking && types.length > 0 ? (
          <MethodPicker
            opener={opener}
            types={types}
            onPick={add}
            onClose={() => setPicking(false)}
          />
        ) : null}
      </div>
      <div ref={list} className="method__list">
        {methods.map((method) => (
          <MethodLines
            key={method.id}
            account={account}
            method={method}
            liveRoll={liveRoll}
            onReplace={replace}
            onRemove={remove}
          />
        ))}
      </div>
    </>
  );
}
