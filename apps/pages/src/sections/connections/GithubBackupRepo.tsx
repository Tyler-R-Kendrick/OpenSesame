import type { Connection } from "@opensesame/app-core/lib/connections.js";
import type { AppInstallAccount } from "@opensesame/app-core/lib/github-app-repos.js";
import type { Flash } from "@opensesame/app-core/sections/connections/shared.js";
/**
 * Repository field: pick from install/App/Host lists, or create under an
 * install account. Native select — never a hidden datalist.
 */
import { IconEdit } from "../../components/Icons.js";
import { RepoEditor } from "./GithubBackupRepoEditor.js";
import { useGithubBackupRepo } from "./useGithubBackupRepo.js";

export {
  existingRepo,
  repoNameFromSlug,
  resolveBackupSlug,
  sanitizeRepoSlug,
} from "@opensesame/app-core/sections/connections/GithubBackupRepoResolve.js";

export function GithubBackupField({
  connection,
  online,
  onFlash,
  onReady,
  seedAccounts = [],
  seedRepos = [],
}: {
  connection: Connection;
  online: boolean;
  onFlash: (flash: Flash) => void;
  onReady?: (ready: boolean) => void;
  seedAccounts?: AppInstallAccount[];
  seedRepos?: string[];
}) {
  const state = useGithubBackupRepo(
    connection,
    online,
    onFlash,
    onReady,
    seedAccounts,
    seedRepos,
  );
  if (state.bound && !state.editing) {
    return (
      <p className="conn-card__repo">
        <span className="conn-card__ref" data-testid="github-backup-repo">
          {state.selected}
        </span>
        <button
          type="button"
          className="icon-btn icon-btn--sm"
          aria-label="Edit repository"
          title="Edit repository"
          data-testid="github-repo-edit"
          onClick={() => {
            state.setDraft(state.selected);
            state.setEditing(true);
            state.setIssue(null);
          }}
        >
          <IconEdit size={16} />
        </button>
      </p>
    );
  }

  return <RepoEditor state={state} />;
}
