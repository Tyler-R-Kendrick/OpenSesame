import { buildRepoSuggestions } from "@opensesame/app-core/sections/connections/GithubBackupRepoSuggestions.js";
/**
 * One repository combobox: type a valid owner/repo or pick from the list.
 */
import { useId, useMemo, useRef, useState } from "react";
import { IconRefresh } from "../../components/Icons.js";
import { StatusMark } from "../../components/StatusMark.js";
import {
  RepoComboboxFrame,
  applyChoice,
  useOutsideClose,
} from "./GithubBackupRepoCombobox.js";
import type { useGithubBackupRepo } from "./useGithubBackupRepo.js";

type RepoState = ReturnType<typeof useGithubBackupRepo>;

export function RepoEditor({ state }: { state: RepoState }) {
  const listId = useId();
  const inputId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [filter, setFilter] = useState("");
  const skipBlur = useRef(false);
  const suggestions = useMemo(
    () =>
      buildRepoSuggestions({
        draft: state.draft,
        filter,
        repos: state.repos,
        accounts: state.accounts,
        listError: state.listError,
      }),
    [state.draft, filter, state.repos, state.accounts, state.listError],
  );

  useOutsideClose(open, rootRef, setOpen);

  const choose = (value: string) =>
    applyChoice(state, value, setFilter, setOpen);

  return (
    <div
      className="conn-repo-field"
      data-testid="github-repo-editor"
      ref={rootRef}
    >
      <div className="conn-card__repo">
        <RepoComboboxFrame
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
          className="icon-btn icon-btn--sm"
          aria-label="Refresh repositories"
          title="Refresh repositories"
          data-testid="github-repo-refresh"
          disabled={!state.online || state.busy || state.loading}
          onClick={() => void state.reload()}
        >
          <IconRefresh size={16} />
        </button>
      </div>
      <RepoStatusMarks state={state} />
    </div>
  );
}

function RepoStatusMarks({ state }: { state: RepoState }) {
  return (
    <>
      {state.issue ? <StatusMark tone="err" label={state.issue} /> : null}
      {state.listError ? (
        <StatusMark tone="err" label={state.listError} />
      ) : null}
      {!state.online ? (
        <StatusMark tone="warn" label="Connect online to choose a repository" />
      ) : null}
      {state.online &&
      !state.loading &&
      !state.listError &&
      state.repos.length === 0 &&
      state.accounts.length === 0 ? (
        <StatusMark
          tone="warn"
          label="Install the GitHub App, then choose a repository"
        />
      ) : null}
    </>
  );
}
