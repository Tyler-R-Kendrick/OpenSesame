/**
 * Combobox chrome for the GitHub backup repository field.
 */
import { type KeyboardEvent, useEffect } from "react";
import { IconChevronRight } from "../../components/Icons.js";
import { DEFAULT_PASSWORD_REPO_NAME } from "../../lib/github-history.js";
import { sanitizeRepoSlug } from "./GithubBackupRepoResolve.js";
import type { RepoSuggestion } from "./GithubBackupRepoSuggestions.js";
import type { useGithubBackupRepo } from "./useGithubBackupRepo.js";

type RepoState = ReturnType<typeof useGithubBackupRepo>;

export function RepoComboboxFrame({
  state,
  inputId,
  listId,
  open,
  active,
  suggestions,
  skipBlur,
  setOpen,
  setActive,
  setFilter,
  choose,
}: {
  state: RepoState;
  inputId: string;
  listId: string;
  open: boolean;
  active: number;
  suggestions: RepoSuggestion[];
  skipBlur: { current: boolean };
  setOpen: (value: boolean | ((current: boolean) => boolean)) => void;
  setActive: (value: number | ((current: number) => number)) => void;
  setFilter: (value: string | ((current: string) => string)) => void;
  choose: (value: string) => Promise<void>;
}) {
  return (
    <div className="conn-repo-combobox">
      <RepoComboboxInput
        state={state}
        inputId={inputId}
        listId={listId}
        open={open}
        active={active}
        suggestions={suggestions}
        skipBlur={skipBlur}
        setOpen={setOpen}
        setActive={setActive}
        setFilter={setFilter}
        choose={choose}
      />
      <button
        type="button"
        className="icon-btn icon-btn--sm conn-repo-combobox__toggle"
        aria-label="Show repositories"
        title="Show repositories"
        aria-expanded={open}
        aria-controls={listId}
        data-testid="github-repo-toggle"
        disabled={!state.online || state.busy}
        onMouseDown={(event) => {
          // Keep focus in the field so blur cannot close before this click.
          event.preventDefault();
          skipBlur.current = true;
        }}
        onClick={() => {
          setFilter((current) => {
            setOpen((wasOpen) => {
              if (wasOpen && current === "") return false;
              return true;
            });
            return "";
          });
        }}
      >
        <IconChevronRight
          size={14}
          className={`conn-repo-combobox__caret${open ? " is-open" : ""}`}
        />
      </button>
      {open ? (
        <SuggestionList
          listId={listId}
          suggestions={suggestions}
          active={active}
          loading={state.loading}
          listError={state.listError}
          skipBlur={skipBlur}
          setActive={setActive}
          choose={choose}
        />
      ) : null}
    </div>
  );
}

export async function applyChoice(
  state: RepoState,
  value: string,
  setFilter: (value: string) => void,
  setOpen: (value: boolean) => void,
) {
  const slug = sanitizeRepoSlug(value);
  state.setIssue(null);
  state.setDraft(slug);
  setFilter("");
  setOpen(false);
  await state.commit(slug);
}

export function useOutsideClose(
  open: boolean,
  rootRef: { current: HTMLDivElement | null },
  setOpen: (value: boolean) => void,
) {
  useEffect(() => {
    if (!open) return;
    function onDoc(event: MouseEvent) {
      const node = event.target;
      if (!(node instanceof Node)) return;
      if (!rootRef.current?.contains(node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open, rootRef, setOpen]);
}

function RepoComboboxInput({
  state,
  inputId,
  listId,
  open,
  active,
  suggestions,
  skipBlur,
  setOpen,
  setActive,
  setFilter,
  choose,
}: {
  state: RepoState;
  inputId: string;
  listId: string;
  open: boolean;
  active: number;
  suggestions: RepoSuggestion[];
  skipBlur: { current: boolean };
  setOpen: (value: boolean) => void;
  setActive: (value: number | ((current: number) => number)) => void;
  setFilter: (value: string) => void;
  choose: (value: string) => Promise<void>;
}) {
  const activeId = open && suggestions[active] ? `${listId}-${active}` : null;
  const activeProps =
    activeId === null ? {} : { "aria-activedescendant": activeId };

  return (
    <input
      id={inputId}
      name="repository"
      role="combobox"
      aria-label="Repository"
      aria-autocomplete="list"
      aria-expanded={open}
      aria-controls={listId}
      {...activeProps}
      data-testid="github-repo-input"
      value={state.draft}
      placeholder={
        state.accounts[0]
          ? `${state.accounts[0].accountLogin}/${DEFAULT_PASSWORD_REPO_NAME}`
          : "owner/repo"
      }
      disabled={!state.online || state.busy}
      spellCheck={false}
      autoCapitalize="off"
      autoCorrect="off"
      aria-invalid={state.issue ? true : undefined}
      onChange={(event) => {
        const next = sanitizeRepoSlug(event.target.value);
        state.setIssue(null);
        state.setDraft(next);
        setFilter(next);
        setOpen(true);
        setActive(0);
      }}
      onFocus={() => setOpen(true)}
      onBlur={() => {
        if (skipBlur.current) {
          skipBlur.current = false;
          return;
        }
        setOpen(false);
        void state.commit(sanitizeRepoSlug(state.draft));
      }}
      onKeyDown={(event) =>
        handleComboboxKey(event, {
          open,
          setOpen,
          active,
          setActive,
          suggestions,
          skipBlur,
          bound: state.bound,
          selected: state.selected,
          setDraft: state.setDraft,
          setEditing: state.setEditing,
          setIssue: state.setIssue,
          choose,
        })
      }
    />
  );
}

function SuggestionList({
  listId,
  suggestions,
  active,
  loading,
  listError,
  skipBlur,
  setActive,
  choose,
}: {
  listId: string;
  suggestions: RepoSuggestion[];
  active: number;
  loading: boolean;
  listError: string | null;
  skipBlur: { current: boolean };
  setActive: (value: number) => void;
  choose: (value: string) => Promise<void>;
}) {
  const emptyLabel = loading
    ? "Loading…"
    : listError
      ? "Repositories unavailable"
      : "No matching repositories";
  return (
    // biome-ignore lint/a11y/useSemanticElements: ARIA combobox listbox not a native select
    // biome-ignore lint/a11y/useFocusableInteractive: focus stays on the combobox input via aria-activedescendant
    <div
      role="listbox"
      id={listId}
      className="conn-repo-combobox__list"
      data-testid="github-repo-list"
    >
      {suggestions.length === 0 ? (
        <div className="conn-repo-combobox__empty" role="presentation">
          {emptyLabel}
        </div>
      ) : (
        suggestions.map((row, index) =>
          renderOption(row, index, listId, active, skipBlur, setActive, choose),
        )
      )}
    </div>
  );
}

function renderOption(
  row: RepoSuggestion,
  index: number,
  listId: string,
  active: number,
  skipBlur: { current: boolean },
  setActive: (value: number) => void,
  choose: (value: string) => Promise<void>,
) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: ARIA combobox option under listbox
    // biome-ignore lint/a11y/useFocusableInteractive: options reached via aria-activedescendant on the input
    <div
      role="option"
      key={`${row.kind}:${row.value}`}
      id={`${listId}-${index}`}
      className={
        index === active
          ? "conn-repo-combobox__option is-active"
          : "conn-repo-combobox__option"
      }
      aria-selected={index === active}
      onMouseDown={(event) => {
        event.preventDefault();
        skipBlur.current = true;
        void choose(row.value);
      }}
      onMouseEnter={() => setActive(index)}
    >
      {row.label}
    </div>
  );
}
type ComboboxKeyContext = {
  open: boolean;
  setOpen: (value: boolean) => void;
  active: number;
  setActive: (value: number | ((current: number) => number)) => void;
  suggestions: RepoSuggestion[];
  skipBlur: { current: boolean };
  bound: boolean;
  selected: string;
  setDraft: (value: string) => void;
  setEditing: (value: boolean) => void;
  setIssue: (value: string | null) => void;
  choose: (value: string) => Promise<void>;
};

function handleComboboxKey(
  event: KeyboardEvent<HTMLInputElement>,
  ctx: ComboboxKeyContext,
) {
  if (event.key === "Escape") {
    event.preventDefault();
    ctx.skipBlur.current = true;
    ctx.setOpen(false);
    ctx.setIssue(null);
    if (ctx.bound) {
      ctx.setDraft(ctx.selected);
      ctx.setEditing(false);
    }
    return;
  }
  if (event.key === "ArrowDown") {
    event.preventDefault();
    ctx.setOpen(true);
    ctx.setActive((index) =>
      ctx.suggestions.length === 0
        ? 0
        : Math.min(index + 1, ctx.suggestions.length - 1),
    );
    return;
  }
  if (event.key === "ArrowUp") {
    event.preventDefault();
    ctx.setActive((index) => Math.max(index - 1, 0));
    return;
  }
  if (event.key !== "Enter") return;
  event.preventDefault();
  const pick = ctx.suggestions[ctx.active];
  if (ctx.open && pick) {
    ctx.skipBlur.current = true;
    void ctx.choose(pick.value);
    return;
  }
  void ctx.choose(sanitizeRepoSlug(event.currentTarget.value));
}
