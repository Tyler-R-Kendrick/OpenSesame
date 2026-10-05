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
import { IconArrowRight, IconSearch } from "../../components/Icons.js";
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
 * The one field at the foot of the support sheet.
 *
 * With a model ready it asks. With nothing to answer it searches the written
 * help instead, live as you type, and says so on the button — the same field,
 * a different verb, because a second field would be the same field twice. The
 * statusline CommandBar is the always-on field; unmatched commands land here.
 */
export function SupportComposer({
  query,
  onQueryChange,
}: {
  query: string;
  onQueryChange: (next: string) => void;
}): ReactElement {
  const { view, support } = useSupport();
  const askId = useId();
  const [question, setQuestion] = useState("");
  const modelReady = view.availability?.kind === "ready";
  const label = modelReady
    ? "Ask about this screen"
    : "Search the written help";
  // Searching filters as you type, so the field holds the filter itself and
  // clearing it restores the whole list. Asking holds a draft until submitted.
  const value = modelReady ? question : query;
  const onChange = (next: string) => {
    if (modelReady) setQuestion(next);
    else onQueryChange(next);
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!modelReady) return;
    const asked = question.trim();
    if (!asked) return;
    setQuestion("");
    void support.ask(asked);
  };

  return (
    <form className="support__composer keyed-row" onSubmit={submit}>
      <label className="visually-hidden" htmlFor={askId}>
        {label}
      </label>
      <div className="f__shell">
        <input
          id={askId}
          className="f__input"
          type={modelReady ? "text" : "search"}
          value={value}
          maxLength={SUPPORT_LIMITS.maxQuestionChars}
          placeholder={label}
          onChange={(event) => onChange(event.target.value)}
        />
      </div>
      <button
        type="submit"
        className="icon-btn"
        disabled={value.trim().length === 0}
        aria-label={modelReady ? "Ask" : "Search"}
        title={modelReady ? "Ask" : "Search"}
      >
        {modelReady ? <IconArrowRight size={17} /> : <IconSearch size={17} />}
      </button>
    </form>
  );
}
