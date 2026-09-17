import { SUPPORT_LIMITS } from "@opensesame/support-agent";
import {
  type FormEvent,
  type ReactElement,
  type ReactNode,
  createContext,
  useContext,
  useId,
  useMemo,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useSupport } from "../session.js";

type SupportSlotApi = {
  slot: HTMLElement | null;
  setSlot: (node: HTMLElement | null) => void;
  askSlot: HTMLElement | null;
  setAskSlot: (node: HTMLElement | null) => void;
};

const noopSetSlot = (_node: HTMLElement | null): void => {};

const SupportSlotContext = createContext<SupportSlotApi>({
  slot: null,
  setSlot: noopSetSlot,
  askSlot: null,
  setAskSlot: noopSetSlot,
});

/** Shares the statusline seats with the launcher. Wrap the shell and launcher. */
export function SupportSlotProvider({
  children,
}: {
  children?: ReactNode;
}): ReactElement {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const [askSlot, setAskSlot] = useState<HTMLElement | null>(null);
  const value = useMemo(
    () => ({ slot, setSlot, askSlot, setAskSlot }),
    [slot, askSlot],
  );
  return (
    <SupportSlotContext.Provider value={value}>
      {children}
    </SupportSlotContext.Provider>
  );
}

/** Empty seat on the statusline. The launcher portals the mark into it. */
export function SupportSlot(): ReactElement {
  const { setSlot } = useContext(SupportSlotContext);
  return <span ref={setSlot} className="statusline__support" />;
}

/** Empty seat for the ask field. The composer portals into it. */
export function SupportAskSlot(): ReactElement {
  const { setAskSlot } = useContext(SupportSlotContext);
  return <div ref={setAskSlot} className="statusline__ask" />;
}

export function useSupportMarkSlot(): HTMLElement | null {
  return useContext(SupportSlotContext).slot;
}

export function useSupportAskSlot(): HTMLElement | null {
  return useContext(SupportSlotContext).askSlot;
}

/**
 * The ask field. It belongs to the outer chrome (the statusline), not the
 * support sheet: a question is how you open the transcript, and chrome is
 * what stays put while screens change.
 */
export function SupportComposer({
  slot,
}: {
  slot: HTMLElement | null;
}): ReactElement {
  const { view, support } = useSupport();
  const askId = useId();
  const [question, setQuestion] = useState("");
  const canAsk = view.availability?.kind === "ready" && !view.thinking;

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const asked = question;
    setQuestion("");
    if (!view.open) support.open();
    void support.ask(asked);
  };

  const form = (
    <form className="support__composer" onSubmit={submit}>
      <label className="visually-hidden" htmlFor={askId}>
        Ask about this screen
      </label>
      <div className="f__shell">
        <input
          id={askId}
          className="f__input"
          type="text"
          value={question}
          maxLength={SUPPORT_LIMITS.maxQuestionChars}
          placeholder={canAsk ? "Ask about this screen" : "Questions only"}
          disabled={!canAsk}
          onChange={(event) => setQuestion(event.target.value)}
        />
      </div>
      <button
        type="submit"
        className="btn btn--primary"
        disabled={!canAsk || question.trim().length === 0}
      >
        Ask
      </button>
    </form>
  );

  return slot ? createPortal(form, slot) : form;
}
