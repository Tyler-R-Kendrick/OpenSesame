import { readMethodPassword } from "@opensesame/app-core/lib/account-password.js";
import { setStatusNotice } from "@opensesame/app-core/lib/notices.js";
import { storePassword } from "@opensesame/app-core/lib/vault/generators/index.js";
import {
  type AccountItem,
  type PasswordMethod,
  needsPepper,
} from "@opensesame/vault-core";
import { useEffect, useState } from "react";
import {
  ConcealedValue,
  CopyButton,
  FieldRow,
  RevealButton,
} from "../../components/FieldRow.js";
import {
  type PepperAskFn,
  isPepperCancelled,
} from "../../components/PepperPrompt.js";
import { StatusMark } from "../../components/StatusMark.js";
import { UpdateSecretPanel } from "./SecretUpdate.js";
import { StrengthBar } from "./StrengthBar.js";

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
  const [shown, setShown] = useState<string | null>(null);
  const [wrong, setWrong] = useState(false);
  const sphinx = method.generator.id === "sphinx";
  const asks = needsPepper(method);
  const key = `password:${method.id}`;

  // biome-ignore lint/correctness/useExhaustiveDependencies: the method is the trigger — a value read from an earlier version must not outlive it
  useEffect(() => {
    setShown(null);
    setWrong(false);
  }, [method]);

  async function read(): Promise<string | null> {
    const reading = await readMethodPassword(item, method, async () => {
      try {
        return await ask(
          "enter",
          sphinx ? "Use master input" : "Use pepper",
          sphinx ? "Master input" : "Pepper",
        );
      } catch (caught) {
        if (isPepperCancelled(caught)) return null;
        throw caught;
      }
    });
    if (reading.status === "wrong") {
      setWrong(true);
      setStatusNotice({
        id: `pepper:${method.id}`,
        tone: "err",
        title: "Pepper",
        body: "That pepper did not open this password.",
      });
      return null;
    }
    if (reading.status !== "ok") return null;
    setWrong(false);
    return reading.password;
  }

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
