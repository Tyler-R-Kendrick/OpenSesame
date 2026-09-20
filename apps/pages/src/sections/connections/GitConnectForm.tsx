/**
 * Generic git remote connector — forge-agnostic backup auth.
 */
import type { Connection, Provider } from "../../lib/connections.js";
import { GitConnectFields } from "./GitConnectFields.js";
import type { Flash } from "./shared.js";
import { useGitConnectForm } from "./useGitConnectForm.js";

export { GIT_AUTH_MODES, type GitAuthMode } from "../../lib/git-auth-modes.js";

export function GitConnectForm({
  provider,
  online,
  onFlash,
  onConnected,
  onRememberOffer,
}: {
  provider: Provider;
  online: boolean;
  onFlash: (flash: Flash) => void;
  onConnected: () => void;
  onRememberOffer?: (connection: Connection) => void;
}) {
  const model = useGitConnectForm({
    provider,
    online,
    onFlash,
    onConnected,
    onRememberOffer,
  });
  return <GitConnectFields model={model} />;
}
