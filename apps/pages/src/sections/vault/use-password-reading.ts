import { readMethodPassword } from "@opensesame/app-core/lib/account-password.js";
import { setStatusNotice } from "@opensesame/app-core/lib/notices.js";
import type { AccountItem, PasswordMethod } from "@opensesame/vault-core";
import { useEffect, useState } from "react";
import {
  type PepperAskFn,
  isPepperCancelled,
} from "../../components/PepperPrompt.js";

/**
 * Reading one password method on the detail page. What is read is held in
 * state only while it is shown, and goes when it is hidden or the method
 * changes. A wrong pepper is a mark and a tray notice, never a box.
 */
export function usePasswordReading(
  item: AccountItem,
  method: PasswordMethod,
  ask: PepperAskFn,
) {
  const [shown, setShown] = useState<string | null>(null);
  const [wrong, setWrong] = useState(false);
  const sphinx = method.generator.id === "sphinx";

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

  return { shown, setShown, wrong, read };
}
