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
 * GitHub's one road on a connector page: register an App from this browser
 * (the Manifest flow, returned through the Connect callback relay). GitHub is
 * the only provider this panel draws for; every other authorize-only provider
 * goes through Connect, and a key or configuration is its own form.
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

  // Already registered: App presence lives in GithubAppPresence. Do not
  // re-draw Create App or any other setup chrome.
  if (
    provider.id !== "github" ||
    provider.configured ||
    localGithubApp !== null
  ) {
    return null;
  }

  return (
    <div className="conn-client-setup">
      <FormCommit
        label={
          busy === "app"
            ? "Opening GitHub"
            : "Create GitHub App for this organization"
        }
        disabled={!online || busy !== null}
        icon={<IconExternal size={18} />}
        onClick={() => void deployGithubApp()}
      />
    </div>
  );
}
