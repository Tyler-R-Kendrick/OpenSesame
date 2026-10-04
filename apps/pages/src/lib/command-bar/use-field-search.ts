import { liveSearchOf } from "@opensesame/app-core/lib/command-bar/parse.js";
import { type KeyboardEvent, type RefObject, useEffect, useRef } from "react";
import { useLocation, useNavigate } from "react-router";
import { commitToConsumer, publishSearch } from "./search.js";

/**
 * Search happens in the shell's one text field: the words are published as
 * they are typed and the listing on screen narrows to them. Enter keeps them
 * where they are — it never empties the field or opens a notice over it — and
 * Esc empties it.
 */
export function useFieldSearch({
  value,
  setValue,
  inputRef,
}: {
  value: string;
  setValue: (next: string) => void;
  inputRef: RefObject<HTMLInputElement | null>;
}) {
  const navigate = useNavigate();
  const live = liveSearchOf(value);
  useEffect(() => publishSearch(live), [live]);
  useEffect(() => () => publishSearch(null), []);

  const valueRef = useRef(value);
  valueRef.current = value;
  const section = useLocation().pathname.split("/")[1] ?? "";
  const lastSection = useRef(section);
  const committing = useRef(false);
  // Words typed for one section do not follow a person into another — unless
  // Enter is what took them there.
  useEffect(() => {
    if (lastSection.current === section) return;
    lastSection.current = section;
    if (committing.current) {
      committing.current = false;
      return;
    }
    if (liveSearchOf(valueRef.current) !== null) setValue("");
  }, [section, setValue]);

  return {
    live,
    /** Enter: hand the keyboard to the listing that is searching. */
    commit: () => {
      if ((live ?? "").trim() === "") return;
      inputRef.current?.blur();
      if (commitToConsumer()) return;
      // Nothing on screen is searching: bring up the vault's list, which
      // reads the words from the field.
      committing.current = true;
      navigate("/vault?f=all");
    },
    /** Esc in the field empties a search; true when this key was that. */
    onEscape: (
      event: KeyboardEvent<HTMLInputElement>,
      suggestionsOpen: boolean,
    ) => {
      if (event.key !== "Escape" || live === null || suggestionsOpen) {
        return false;
      }
      event.preventDefault();
      setValue("");
      return true;
    },
  };
}
