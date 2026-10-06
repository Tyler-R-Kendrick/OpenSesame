import { setStatusNotice } from "@opensesame/app-core/lib/notices.js";
import { convertLegacyMethod } from "@opensesame/app-core/lib/vault/generators/index.js";
import {
  type AccountItem,
  type PasswordMethod,
  WrongPepperError,
} from "@opensesame/vault-core";
import { useState } from "react";
import { IconRefresh } from "../../components/Icons.js";
import {
  isPepperCancelled,
  usePepperPrompt,
} from "../../components/PepperPrompt.js";
import { StatusMark } from "../../components/StatusMark.js";
import { CredentialLine } from "./CredentialLine.js";

/**
 * A password an older version made from a pepper (or Sphinx master input) the
 * person typed (ADR 0174 §5). It cannot be produced without that input, and a
 * pepper is not asked for now, so it is converted once: the old input opens it,
 * and what it was is kept as an ordinary stored password. The input is used for
 * that one call and kept by nobody.
 */
export function LegacyConvert({
  account,
  method,
  onConvert,
  onRemove,
}: {
  account: AccountItem;
  method: PasswordMethod;
  onConvert: (next: PasswordMethod) => void | Promise<void>;
  /** Drawn in the editor, where the line ends in a remove ×; absent on the page. */
  onRemove?: () => void;
}) {
  const prompt = usePepperPrompt();
  const [wrong, setWrong] = useState(false);

  const convert = async () => {
    try {
      const input = await prompt.ask("Convert password", "Earlier pepper");
      const next = await convertLegacyMethod(account, method, input);
      setWrong(false);
      await onConvert(next);
    } catch (caught) {
      if (isPepperCancelled(caught)) return;
      if (!(caught instanceof WrongPepperError)) throw caught;
      setWrong(true);
      setStatusNotice({
        id: `pepper:${method.id}`,
        tone: "err",
        title: "Earlier pepper",
        body: "That did not open this password.",
      });
    }
  };

  return (
    <>
      <CredentialLine
        label="Password"
        htmlFor={`${method.id}-convert`}
        remove={onRemove ? { label: "Remove password", onRemove } : undefined}
        field={
          <div className="editor__inline">
            <StatusMark
              tone={wrong ? "err" : "idle"}
              label={
                wrong
                  ? "That did not open it"
                  : "Made with an earlier pepper: convert it once"
              }
            />
            <button
              id={`${method.id}-convert`}
              type="button"
              className="icon-btn"
              aria-label="Convert password"
              title="Convert password"
              onClick={() => void convert()}
            >
              <IconRefresh size={17} />
            </button>
          </div>
        }
      />
      {prompt.element}
    </>
  );
}
