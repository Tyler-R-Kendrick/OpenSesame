import { storePassword } from "@opensesame/app-core/lib/vault/generators/index.js";
import {
  type AccountItem,
  type PasswordMethod,
  needsPepper,
} from "@opensesame/vault-core";
import {
  ConcealedValue,
  CopyButton,
  FieldRow,
  RevealButton,
} from "../../components/FieldRow.js";
import type { PepperAskFn } from "../../components/PepperPrompt.js";
import { StatusMark } from "../../components/StatusMark.js";
import { UpdateSecretPanel } from "./SecretUpdate.js";
import { StrengthBar } from "./StrengthBar.js";
import { usePasswordReading } from "./use-password-reading.js";

type Copying = {
  copied: string | null;
  failed: string | null;
  copy: (key: string, value: string) => Promise<void>;
};

/**
 * One password method on the detail page. Revealing or copying a password that
 * needs a pepper (or a Sphinx master input) asks for it first; what is read is
 * held in state only while it is shown, and goes when it is hidden, when the
 * method changes, or when the page does.
 */
export function AccountPasswordRow({
  item,
  method,
  title,
  ask,
  copying,
  onSave,
}: {
  item: AccountItem;
  method: PasswordMethod;
  title: string;
  ask: PepperAskFn;
  copying: Copying;
  onSave: (method: PasswordMethod) => Promise<void>;
}) {
  const { shown, setShown, wrong, read } = usePasswordReading(
    item,
    method,
    ask,
  );
  const sphinx = method.generator.id === "sphinx";
  const asks = needsPepper(method);
  const key = `password:${method.id}`;

  const empty = !asks && method.secret === "";
  const update = sphinx ? null : (
    <UpdateSecretPanel
      label="password"
      onUpdate={async (next) => {
        // A new peppered password is sealed under a pepper typed twice.
        const pepper = method.pepper ? await ask("set", "Set pepper") : null;
        await onSave(await storePassword(item.id, method, next, pepper));
      }}
    />
  );
  if (empty) return update;

  return (
    <FieldRow
      label={title}
      actions={
        <>
          <RevealButton
            revealed={shown !== null}
            label="password"
            onToggle={() => {
              if (shown !== null) {
                setShown(null);
                return;
              }
              void read().then((password) => {
                if (password !== null) setShown(password);
              });
            }}
          />
          <CopyButton
            value=""
            label="password"
            fieldKey={key}
            copied={copying.copied}
            failed={copying.failed}
            onCopy={async (fieldKey) => {
              const password = await read();
              if (password !== null) await copying.copy(fieldKey, password);
            }}
          />
        </>
      }
    >
      <ConcealedValue
        value={shown ?? ""}
        label="password"
        revealed={shown !== null}
      />
      {asks ? (
        <StatusMark
          tone={wrong ? "err" : "idle"}
          label={
            wrong
              ? "Wrong pepper"
              : sphinx
                ? "Computed on use, never stored"
                : "Sealed under a pepper"
          }
        />
      ) : null}
      {shown !== null ? <StrengthBar password={shown} /> : null}
      {update}
    </FieldRow>
  );
}
