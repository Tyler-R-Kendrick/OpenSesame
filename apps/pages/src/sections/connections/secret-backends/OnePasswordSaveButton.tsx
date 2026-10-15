import type { SaveRequestField } from "@1password/save-button";
import { createLocalVaultBackend } from "@opensesame/app-core/lib/secret-backends/local.js";
import { secretBackendDraft } from "@opensesame/app-core/lib/secret-backends/presets.js";
import type {
  SecretBackendItem,
  SecretBackendItemSummary,
} from "@opensesame/app-core/lib/secret-backends/types.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import type { Flash } from "@opensesame/app-core/sections/connections/shared.js";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { FailureNotice } from "../../../components/FailureNotice.js";
import { FieldShell } from "../../../components/FieldShell.js";
import { FormCommit } from "../../../components/FormCommit.js";
import { IconKey } from "../../../components/IconKey.js";
import { IconRefresh, IconX } from "../../../components/Icons.js";
import { StatusMark } from "../../../components/StatusMark.js";
import { useSecretBackendAction } from "./useSecretBackendAction.js";

async function officialSaveElement(item: SecretBackendItem) {
  if (item.kind !== "login") throw new Error("Choose a login item.");
  if (item.url && new URL(item.url).origin !== window.location.origin)
    throw new Error(
      "The 1Password save button saves logins for this browser origin. Choose a login for this origin.",
    );
  const sdk = await import("@1password/save-button");
  // SAFETY: checked the SDK declaration contract: AutofillType.Username is exactly "username".
  const username = "username" as SaveRequestField["autocomplete"];
  // SAFETY: checked the SDK declaration contract: AutofillType.CurrentPassword is exactly "current-password".
  const password = "current-password" as SaveRequestField["autocomplete"];
  const fields: SaveRequestField[] = [
    {
      autocomplete: username,
      value: item.username ?? "",
    },
    {
      autocomplete: password,
      value: item.secret,
    },
  ];
  const value = sdk.encodeOPSaveRequest({
    title: item.name,
    fields,
    notes: item.notes,
  });
  if (!value) throw new Error("1Password refused this save request.");
  const button = document.createElement("onepassword-save-button");
  button.setAttribute("data-onepassword-type", "login");
  button.setAttribute(
    "data-theme",
    getComputedStyle(document.documentElement).colorScheme === "dark"
      ? "dark"
      : "light",
  );
  button.setAttribute("value", value);
  return { button, activate: sdk.activateOPButton };
}

/** Official extension handoff; preparing or clicking it is never proof of a saved item. */
function useOnePasswordSave(onFlash: (flash: Flash) => void) {
  const container = useRef<HTMLDivElement>(null);
  const prepared = useRef<HTMLElement | null>(null);
  const revision = useRef(0);
  const [items, setItems] = useState<SecretBackendItemSummary[]>([]);
  const [selected, setSelected] = useState("");
  const status = useSecretBackendAction(onFlash);
  const clear = useCallback(() => {
    revision.current += 1;
    const element = prepared.current;
    element?.removeAttribute("value");
    element?.shadowRoot?.querySelector("[value]")?.removeAttribute("value");
    element?.remove();
    prepared.current = null;
    container.current?.replaceChildren();
  }, []);
  useEffect(() => {
    const off = vaultStore.onLock(() => {
      clear();
      setItems([]);
      setSelected("");
    });
    return () => {
      off();
      clear();
    };
  }, [clear]);
  function list() {
    void status.run(async () => {
      const backend = createLocalVaultBackend();
      const session = await backend.authenticate(
        secretBackendDraft("local-vault"),
      );
      try {
        setItems(
          (await backend.listItems(session)).filter(
            (item) => item.kind === "login",
          ),
        );
        return "Local logins loaded";
      } finally {
        await backend.disconnect(session);
      }
    });
  }
  function prepare() {
    clear();
    const started = revision.current;
    void status.run(async () => {
      const backend = createLocalVaultBackend();
      const session = await backend.authenticate(
        secretBackendDraft("local-vault"),
      );
      try {
        const item = await backend.getItem(selected, session);
        const official = await officialSaveElement(item);
        if (revision.current !== started || !container.current)
          return undefined;
        container.current.append(official.button);
        prepared.current = official.button;
        official.activate();
        return "1Password save button prepared";
      } finally {
        await backend.disconnect(session);
      }
    });
  }
  return {
    container,
    items,
    selected,
    setSelected,
    status,
    clear,
    list,
    prepare,
  };
}

export function OnePasswordSaveButton({
  onFlash,
}: { onFlash: (flash: Flash) => void }) {
  const id = useId();
  const {
    container,
    items,
    selected,
    setSelected,
    status,
    clear,
    list,
    prepare,
  } = useOnePasswordSave(onFlash);
  return (
    <section className="panel" aria-label="Save in 1Password">
      <div className="panel__head">
        <h2>Save in 1Password</h2>
        <IconKey
          label="List local logins for 1Password"
          disabled={status.busy}
          onClick={list}
        >
          <IconRefresh size={17} />
        </IconKey>
        <IconKey
          label="Clear 1Password save request"
          disabled={status.busy}
          onClick={clear}
        >
          <IconX size={17} />
        </IconKey>
        {status.failure ? (
          <StatusMark tone="err" label={status.failure} />
        ) : null}
        {status.result ? <StatusMark tone="ok" label={status.result} /> : null}
      </div>
      <div className="panel__body cx-form">
        <FieldShell
          label="Saved login origin"
          value={window.location.origin}
          readOnly
          mono
        />
        <div className="field">
          <label htmlFor={id}>Local login</label>
          <select
            id={id}
            value={selected}
            disabled={status.busy}
            onChange={(event) => {
              clear();
              setSelected(event.target.value);
            }}
          >
            <option value="">—</option>
            {items.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </div>
        <FormCommit
          label="Prepare official 1Password save button"
          busy={status.busy}
          disabled={status.busy || !selected}
          onClick={prepare}
        />
        <div ref={container} />
      </div>
      <FailureNotice
        id="onepassword-official-save"
        title="Save in 1Password"
        message={status.failure}
      />
    </section>
  );
}
