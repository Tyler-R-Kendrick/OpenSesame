import { liveSearchOf } from "@opensesame/app-core/lib/command-bar/parse.js";
import { type KeyboardEvent, useEffect, useRef } from "react";
import { useLocation, useNavigate } from "react-router";
import { registerCommandBarFill } from "./focus.js";
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
  onFill,
}: {
  value: string;
  setValue: (next: string) => void;
  /** A key that pre-types a verb starts the field fresh: drop what it showed. */
  onFill: () => void;
}) {
  const navigate = useNavigate();
  const live = liveSearchOf(value);
  const fresh = useRef(onFill);
  fresh.current = onFill;
  useEffect(
    () =>
      registerCommandBarFill((next) => {
        fresh.current();
        setValue(next);
      }),
    [setValue],
  );
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
    /** `/? ` with nothing after it yet: there is nothing to run. */
    empty: live !== null && live.trim() === "",
    /**
     * Enter: hand the keyboard to the listing that is searching. The field is
     * never blurred first — focus leaves it only when a listing takes it — so
     * an empty result keeps the caret where the words are.
     */
    commit: () => {
      if ((live ?? "").trim() === "") return;
      if (commitToConsumer() !== "none") return;
      // Nothing on screen is searching: bring up the vault's list, which
      // reads the words from the field. The flag is for the section change
      // this causes, so it is only raised when there is one.
      if (section !== "vault") committing.current = true;
      navigate("/vault?f=all");
    },
    /** Esc in the field empties a search; true when this key was that. */
    onEscape: (
      event: KeyboardEvent<HTMLInputElement>,
      suggestionsOpen: boolean,
    ) => {
      // Escape cancels an IME composition; it is not "empty the search".
      if (event.nativeEvent.isComposing) return false;
      if (event.key !== "Escape" || live === null || suggestionsOpen) {
        return false;
      }
      event.preventDefault();
      setValue("");
      return true;
    },
  };
}
