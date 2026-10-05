import type {
  AccountItem,
  LoginMethod,
  LoginMethodType,
} from "@opensesame/vault-core";
import { useEffect, useRef, useState } from "react";
import { IconKey } from "../../components/IconKey.js";
import { IconPlus, IconX } from "../../components/Icons.js";
import type { PepperAskFn } from "../../components/PepperPrompt.js";
import { MethodPicker, methodTitle, newMethod } from "./MethodPicker.js";
import {
  ApiKeyFields,
  AuthenticatorFields,
  OAuthFields,
  TokenFields,
} from "./OtherMethodEditors.js";
import { PasswordMethodEditor } from "./PasswordMethodEditor.js";
import type { MethodEdit, PlainMap } from "./account-secrets.js";

function MethodFields({
  account,
  method,
  plain,
  ask,
  liveRoll,
  onEdit,
  onChange,
}: {
  account: AccountItem;
  method: LoginMethod;
  plain: PlainMap;
  ask: PepperAskFn;
  liveRoll: boolean;
  onEdit: (edit: MethodEdit) => void;
  onChange: (next: LoginMethod) => void;
}) {
  switch (method.type) {
    case "password":
      return (
        <PasswordMethodEditor
          account={account}
          method={method}
          plain={plain}
          ask={ask}
          liveRoll={liveRoll}
          onEdit={onEdit}
        />
      );
    case "api-key":
      return <ApiKeyFields method={method} onChange={onChange} />;
    case "token":
      return <TokenFields method={method} onChange={onChange} />;
    case "oauth":
      return <OAuthFields method={method} onChange={onChange} />;
    case "authenticator":
      return <AuthenticatorFields method={method} onChange={onChange} />;
  }
}

/** One login method: its title with a remove key, then its own fields. */
function MethodBlock({
  account,
  method,
  plain,
  ask,
  liveRoll,
  onReplace,
  onRemove,
  onPlain,
}: {
  account: AccountItem;
  method: LoginMethod;
  plain: PlainMap;
  ask: PepperAskFn;
  liveRoll: boolean;
  onReplace: (next: LoginMethod) => void;
  onRemove: (method: LoginMethod) => void;
  onPlain: (id: string, entry: MethodEdit["plain"]) => void;
}) {
  const title = methodTitle(account.methods, method);
  return (
    <fieldset
      className="method"
      aria-label={`${title} method`}
      data-method={method.id}
    >
      <span className="label editor__grouplabel">
        {title}
        <IconKey
          small
          label={`Remove ${title.toLowerCase()}`}
          onClick={() => onRemove(method)}
        >
          <IconX size={15} />
        </IconKey>
      </span>
      <MethodFields
        account={account}
        method={method}
        plain={plain}
        ask={ask}
        liveRoll={liveRoll}
        onEdit={(edit) => {
          onReplace(edit.method);
          onPlain(method.id, edit.plain);
        }}
        onChange={onReplace}
      />
    </fieldset>
  );
}

/**
 * The account's login methods: one block each, in order, under a heading whose
 * `+` opens the type choice. An account may hold none, so every block can go.
 */
export function AccountMethods({
  account,
  plain,
  ask,
  liveRoll,
  onMethods,
  onPlain,
}: {
  account: AccountItem;
  plain: PlainMap;
  ask: PepperAskFn;
  liveRoll: boolean;
  onMethods: (methods: LoginMethod[]) => void;
  onPlain: (id: string, entry: MethodEdit["plain"]) => void;
}) {
  const [picking, setPicking] = useState(false);
  const [added, setAdded] = useState<string | null>(null);
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
    onPlain(method.id, null);
  };

  return (
    <div className="field method__group">
      <span className="label editor__grouplabel">
        Login methods
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
      </span>
      {picking ? (
        <MethodPicker
          opener={opener}
          onPick={add}
          onClose={() => setPicking(false)}
        />
      ) : null}
      <div ref={list} className="method__list">
        {methods.map((method) => (
          <MethodBlock
            key={method.id}
            account={account}
            method={method}
            plain={plain}
            ask={ask}
            liveRoll={liveRoll}
            onReplace={replace}
            onRemove={remove}
            onPlain={onPlain}
          />
        ))}
      </div>
    </div>
  );
}
