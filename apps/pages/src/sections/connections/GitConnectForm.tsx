/**
 * Generic git remote connector — forge-agnostic backup auth.
 */
import type {
  Connection,
  Provider,
} from "@opensesame/app-core/lib/connections.js";
import type { Flash } from "@opensesame/app-core/sections/connections/shared.js";
import { GitConnectFields } from "./GitConnectFields.js";
import { useGitConnectForm } from "./useGitConnectForm.js";

export {
  GIT_AUTH_MODES,
  type GitAuthMode,
} from "@opensesame/app-core/lib/git-auth-modes.js";

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
