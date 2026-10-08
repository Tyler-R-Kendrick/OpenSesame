import { packsNeeded } from "@opensesame/app-core/lib/type-packs/requires.js";
import { isPackOn } from "@opensesame/app-core/lib/type-packs/state.js";
import {
  type AccountItem,
  type CredentialItem,
  LOGIN_METHOD_TYPES,
  type LoginMethod,
  type LoginMethodType,
  credentialTypeId,
} from "@opensesame/vault-core";
import { useEffect, useRef, useState } from "react";
import { usePackSnapshot } from "../../bindings/type-packs.js";
import { IconPlus } from "../../components/Icons.js";
import { useVault } from "../../lib/vault/hooks.js";
import { MethodPicker, methodTitle, newMethod } from "./MethodPicker.js";
import {
  ApiKeyLines,
  AuthenticatorLines,
  OAuthLines,
  TokenLines,
} from "./OtherMethodEditors.js";
import { PasswordMethodEditor } from "./PasswordMethodEditor.js";
import { bindableCredentials, credentialPackSeams } from "./account-secrets.js";

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
 * Install a credential type for the draft that chose it, and give back every
 * type the draft switched on when the account is abandoned. An account that is
 * saved holds items of the type, which the vault refuses to give back.
 */
function useDraftPacks(packs: ReturnType<typeof usePackSnapshot>) {
  const switchedOn = useRef(new Set<string>());
  useEffect(() => {
    const mine = switchedOn.current;
    return () => void credentialPackSeams.release([...mine].reverse());
  }, []);
  return (id: string) => {
    if (isPackOn(id, packs)) return;
    for (const pack of [id, ...packsNeeded(id)])
      if (!isPackOn(pack, packs)) switchedOn.current.add(pack);
    credentialPackSeams.enable(id);
  };
}

/**
 * The account's login methods: a heading whose `+` opens the choice of a new
 * method of any type or an existing credential to bind, then each method's
 * lines in order. An account may hold none, so every one can go. The `+` is
 * always there: a type the vault has not switched on is switched on by being
 * chosen (ADR 0165, ADR 0179), so there is no account that cannot take a
 * credential.
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
  const packs = usePackSnapshot();
  const { items } = useVault();
  const { methods } = account;
  const existing = bindableCredentials(items, methods);
  const opener = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const claimPack = useDraftPacks(packs);
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
    // A type that is off is installed by being chosen, for this draft only; the
    // vault keeps it when the account is saved with a credential of it.
    claimPack(credentialTypeId(type));
    const made = newMethod(account, type);
    onMethods([...methods, made]);
    setPicking(false);
    setAdded(made.id);
  };
  const bind = (credential: CredentialItem) => {
    onMethods([...methods, credential.method]);
    setPicking(false);
    setAdded(credential.method.id);
  };
  const remove = (method: LoginMethod) => {
    onMethods(methods.filter((entry) => entry.id !== method.id));
  };

  return (
    <>
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
            types={LOGIN_METHOD_TYPES}
            existing={existing}
            onPick={add}
            onBind={bind}
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
