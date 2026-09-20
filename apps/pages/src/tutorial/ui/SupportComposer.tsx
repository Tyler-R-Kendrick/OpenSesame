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
import { useSupport } from "../session.js";

type SupportSlotApi = {
  slot: HTMLElement | null;
  setSlot: (node: HTMLElement | null) => void;
};

const noopSetSlot = (_node: HTMLElement | null): void => {};

const SupportSlotContext = createContext<SupportSlotApi>({
  slot: null,
  setSlot: noopSetSlot,
});

/** Shares the statusline seat with the launcher. Wrap the shell and launcher. */
export function SupportSlotProvider({
  children,
}: {
  children?: ReactNode;
}): ReactElement {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const value = useMemo(() => ({ slot, setSlot }), [slot]);
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

export function useSupportMarkSlot(): HTMLElement | null {
  return useContext(SupportSlotContext).slot;
}

/**
 * Ask field at the foot of the support sheet. The statusline CommandBar is
 * the always-on field; unmatched commands land here as questions.
 */
export function SupportComposer(): ReactElement {
  const { view, support } = useSupport();
  const askId = useId();
  const [question, setQuestion] = useState("");
  const canAsk = view.availability?.kind === "ready" && !view.thinking;

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const asked = question;
    setQuestion("");
    void support.ask(asked);
  };

  return (
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
          placeholder="Ask about this screen"
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
}
