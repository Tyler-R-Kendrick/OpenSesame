import type { AccountItem } from "@opensesame/vault-core";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  type PepperPromptHandle,
  isPepperCancelled,
  usePepperPrompt,
} from "../../components/PepperPrompt.js";
import { type PlainMap, sealForSave } from "./account-secrets.js";

export type AccountSecrets = {
  plain: PlainMap;
  pepper: PepperPromptHandle;
  /** The Save key, so focus can come back to it. */
  saveRef: React.RefObject<HTMLButtonElement | null>;
  setEntry: (id: string, entry: PlainMap[string] | null) => void;
  /** Forget every plaintext the editor holds. */
  clear: () => void;
  /** The account as it is saved: peppered passwords sealed, no plaintext left in it. */
  seal: (
    account: AccountItem,
    existing: AccountItem | undefined,
  ) => Promise<AccountItem>;
  /** A save that failed: a closed pepper prompt is a decision, so say nothing. Returns whether it was one. */
  cancelled: (caught: Error) => boolean;
};

/**
 * What the account editor holds beside the draft: the plaintext of passwords it
 * is about to seal, and the one pepper prompt (ADR 0168 §4). Closing the prompt
 * at Save hands focus to Save while Save is still disabled for the save in
 * flight; it is taken back once the save has settled.
 */
export function useAccountSecrets(saving: boolean): AccountSecrets {
  const [plain, setPlain] = useState<PlainMap>({});
  const pepper = usePepperPrompt();
  const { ask } = pepper;
  const saveRef = useRef<HTMLButtonElement>(null);
  const refocusSave = useRef(false);
  const settled = !saving;
  useEffect(() => {
    if (settled && refocusSave.current) {
      refocusSave.current = false;
      saveRef.current?.focus();
    }
  }, [settled]);

  const setEntry = useCallback(
    (id: string, entry: PlainMap[string] | null) =>
      setPlain((current) => {
        const { [id]: _dropped, ...rest } = current;
        return entry === null ? rest : { ...rest, [id]: entry };
      }),
    [],
  );
  const clear = useCallback(() => setPlain({}), []);
  const seal = useCallback(
    (account: AccountItem, existing: AccountItem | undefined) =>
      sealForSave(account, existing, plain, ask),
    [plain, ask],
  );
  const cancelled = useCallback((caught: Error) => {
    if (!isPepperCancelled(caught)) return false;
    refocusSave.current = true;
    return true;
  }, []);
  return { plain, pepper, saveRef, setEntry, clear, seal, cancelled };
}
