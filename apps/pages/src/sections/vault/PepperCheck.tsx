import { setStatusNotice } from "@opensesame/app-core/lib/notices.js";
import {
  type AccountItem,
  type PasswordMethod,
  WrongPepperError,
} from "@opensesame/vault-core";
import { useRef } from "react";
import {
  type PepperAskFn,
  isPepperCancelled,
} from "../../components/PepperPrompt.js";
import {
  type MethodEdit,
  type PlainMap,
  pepperOff,
  pepperOn,
} from "./account-secrets.js";

/**
 * *Include pepper.* Turning it on asks for a pepper twice and seals; turning it
 * off asks once, unless the editor already holds the password. Closing the
 * prompt changes nothing; a wrong pepper is a mark (`onWrong`) and a tray
 * notice, never a box.
 */
export function PepperCheck({
  account,
  method,
  plain,
  ask,
  onEdit,
  onWrong,
}: {
  account: AccountItem;
  method: PasswordMethod;
  plain: PlainMap;
  ask: PepperAskFn;
  onEdit: (edit: MethodEdit) => void;
  onWrong: (wrong: boolean) => void;
}) {
  const busy = useRef(false);

  const guarded = async (task: () => Promise<MethodEdit>) => {
    if (busy.current) return;
    busy.current = true;
    try {
      onEdit(await task());
      onWrong(false);
    } catch (caught) {
      if (isPepperCancelled(caught)) return;
      if (!(caught instanceof WrongPepperError)) throw caught;
      onWrong(true);
      setStatusNotice({
        id: `pepper:${method.id}`,
        tone: "err",
        title: "Pepper",
        body: "That pepper did not open this password.",
      });
    } finally {
      busy.current = false;
    }
  };

  return (
    <div className="field">
      <label className="check">
        <input
          type="checkbox"
          checked={method.pepper}
          onChange={(event) => {
            const on = event.target.checked;
            void guarded(() =>
              on
                ? pepperOn(account, method, plain, ask)
                : pepperOff(account, method, plain, ask),
            );
          }}
        />
        <span>Include pepper</span>
      </label>
    </div>
  );
}
