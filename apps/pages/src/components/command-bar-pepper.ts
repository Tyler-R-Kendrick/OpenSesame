import { type RefObject, useCallback, useEffect, useRef } from "react";
import {
  type PepperPromptHandle,
  isPepperCancelled,
  usePepperPrompt,
} from "./PepperPrompt.js";

export type CommandPepper = {
  /** `CommandPorts.askPepper`: the one prompt; closing it is a cancel (null). */
  askPepper: () => Promise<string | null>;
  element: PepperPromptHandle["element"];
  /** The command field, which gets focus back when a command that asked has finished. */
  input: RefObject<HTMLInputElement | null>;
};

export function useCommandPepper(busy: boolean): CommandPepper {
  const { ask, element } = usePepperPrompt();
  const input = useRef<HTMLInputElement>(null);
  const asked = useRef(false);
  const askPepper = useCallback(async (): Promise<string | null> => {
    asked.current = true;
    try {
      return await ask("enter", "Use pepper");
    } catch (caught) {
      if (isPepperCancelled(caught)) return null;
      throw caught;
    }
  }, [ask]);
  // The field is disabled while a command runs, so the focus the pepper prompt
  // hands back lands on nothing; put it back once the field is live again.
  useEffect(() => {
    if (busy || !asked.current) return;
    asked.current = false;
    input.current?.focus();
  }, [busy]);
  return { askPepper, element, input };
}
