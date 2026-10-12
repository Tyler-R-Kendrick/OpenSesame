import { comparePrivatePassword } from "@opensesame/app-core/lib/vault/password-workflows.js";
import {
  type AccountItem,
  type PasswordMethod,
  completePassword,
  handoff,
  isAlgorithmic,
  producePassword,
} from "@opensesame/vault-core";
import { useState } from "react";
import {
  ConcealedValue,
  CopyButton,
  FieldRow,
  RevealButton,
} from "../../components/FieldRow.js";
import { useGuideTarget } from "../../tutorial/registry/react.jsx";
import { LegacyConvert } from "./LegacyConvert.js";
import { UpdateSecretPanel } from "./SecretUpdate.js";
import { StrengthBar } from "./StrengthBar.js";

type Copying = {
  copied: string | null;
  failed: string | null;
  copy: (key: string, value: string) => Promise<void>;
};

/**
 * One password method on the detail page, produced through the one facade
 * (ADR 0174). With *Include pepper* the password is shown with the slot marked,
 * a copy puts out what comes before the slot, and a second key copies what
 * follows it; the pepper is never asked for and never kept. A password an older
 * version made from a typed pepper is converted once, here.
 */
export function AccountPasswordRow({
  item,
  method,
  title,
  copying,
  guide,
  onSave,
}: {
  item: Pick<AccountItem, "id" | "username">;
  method: PasswordMethod;
  title: string;
  copying: Copying;
  /** This row holds the tutorials' `item.copy-password` target. */
  guide: boolean;
  onSave: (method: PasswordMethod) => Promise<void>;
}) {
  const copyRef = useGuideTarget<HTMLButtonElement>("item.copy-password");
  const [revealed, setRevealed] = useState(false);
  const produced = producePassword(method);
  const key = `password:${method.id}`;

  // A computed password is rotated in the editor, never typed over here.
  const update = isAlgorithmic(method) ? null : (
    <UpdateSecretPanel
      itemId={`${item.id}:${method.id}`}
      label="password"
      guideCompare={guide}
      compare={async (candidate) =>
        (await comparePrivatePassword(item.id, candidate, false, method.id))
          .matches
      }
      onUpdate={(next) =>
        onSave({
          ...method,
          secret: next,
          changedAt: new Date().toISOString(),
        })
      }
    />
  );

  if (produced.status === "legacy") {
    return <LegacyConvert account={item} method={method} onConvert={onSave} />;
  }
  if (produced.status === "absent") return update;

  const out = handoff(produced);
  const whole = completePassword(produced);
  const shown =
    produced.status === "slotted"
      ? `${produced.head}‹pepper›${produced.tail}`
      : (whole ?? "");
  return (
    <FieldRow
      label={title}
      actions={
        <>
          <RevealButton
            revealed={revealed}
            label="password"
            onToggle={() => setRevealed((on) => !on)}
          />
          <CopyButton
            value={out?.now ?? ""}
            label="password"
            fieldKey={key}
            copied={copying.copied}
            failed={copying.failed}
            guideRef={guide ? copyRef : undefined}
            onCopy={copying.copy}
          />
          {out !== null && out.later !== "" ? (
            <CopyButton
              value={out.later}
              label="rest of password"
              fieldKey={`${key}:rest`}
              copied={copying.copied}
              failed={copying.failed}
              onCopy={copying.copy}
            />
          ) : null}
        </>
      }
    >
      <ConcealedValue
        value={revealed ? shown : ""}
        label="password"
        revealed={revealed}
      />
      {revealed && whole !== null ? <StrengthBar password={whole} /> : null}
      {update}
    </FieldRow>
  );
}
