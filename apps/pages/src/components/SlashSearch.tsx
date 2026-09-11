/**
 * The `/` search command used by every listing.
 *
 * A key in the toolbar opens it; the prompt under the listing is the field.
 * Escape closes it. Vault items and the connector catalog both use this, so
 * a second in-tree search box is not another way in.
 */

import {
  type Ref,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { registerSearchKeymap } from "../lib/keymap.js";
import "./slash-search.css";

export function useListingSearch() {
  const [query, setQuery] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (query !== null) inputRef.current?.focus();
  }, [query]);
  const open = useCallback(() => setQuery((current) => current ?? ""), []);
  const close = useCallback(() => setQuery(null), []);
  useEffect(() => {
    return registerSearchKeymap({
      search: open,
      closeSearch: close,
    });
  }, [open, close]);
  return { query, setQuery, inputRef, open, close };
}

export function SlashSearchKey({
  onOpen,
  label,
  navRef,
}: {
  onOpen: () => void;
  label?: string;
  navRef?: Ref<HTMLButtonElement>;
}) {
  return (
    <button
      ref={navRef}
      type="button"
      className="vtree__key"
      title="Search (/)"
      aria-label={label}
      onClick={onOpen}
    >
      /
    </button>
  );
}

export function SlashSearchField({
  query,
  onChange,
  onClose,
  onCommit,
  inputRef,
  label,
}: {
  query: string;
  onChange: (value: string) => void;
  onClose: () => void;
  onCommit?: () => void;
  inputRef: RefObject<HTMLInputElement | null>;
  label: string;
}) {
  return (
    <div className="vtree__cmd">
      <span className="vtree__prompt" aria-hidden="true">
        /
      </span>
      <input
        ref={inputRef}
        value={query}
        aria-label={label}
        spellCheck={false}
        autoComplete="off"
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            onClose();
          } else if (event.key === "Enter") {
            onCommit?.();
          }
        }}
      />
    </div>
  );
}
