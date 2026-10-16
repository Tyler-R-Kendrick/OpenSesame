import type { Provider } from "@opensesame/app-core/lib/connections.js";
import {
  readLocalGithubApp,
  subscribeLocalGithubApp,
} from "@opensesame/app-core/lib/github-app-manifest.js";
import type { Flash } from "@opensesame/app-core/sections/connections/shared.js";
import { useState, useSyncExternalStore } from "react";
import { FormCommit } from "../../components/FormCommit.js";
import { IconExternal } from "../../components/Icons.js";
import { useGithubAppRegistration } from "./useGithubAppRegistration.js";
import { useGithubAppReturn } from "./useGithubAppReturn.js";

/**
 * Register an App from this browser using GitHub's Manifest flow and this
 * static app's verified return handler. Native token setup composes this panel.
 */
export function GithubAppRegistrationPanel({
  provider,
  online,
  onFlash,
}: {
  provider: Provider;
  online: boolean;
  onFlash: (flash: Flash) => void;
}) {
  const [busy, setBusy] = useState<"app" | null>(null);
  const deployGithubApp = useGithubAppRegistration(provider, onFlash, setBusy);
  const localGithubApp = useSyncExternalStore(
    subscribeLocalGithubApp,
    readLocalGithubApp,
    () => null,
  );
  useGithubAppReturn(provider.id, onFlash);

  // Saved App facts are composed by the owner; keep its callback mounted.
  if (provider.id !== "github" || localGithubApp !== null) {
    return null;
  }

  return (
    <div className="conn-client-setup">
      <FormCommit
        label={busy === "app" ? "Opening GitHub" : "Create GitHub App"}
        disabled={!online || busy !== null}
        icon={<IconExternal size={18} />}
        onClick={() => void deployGithubApp()}
      />
    </div>
  );
}
