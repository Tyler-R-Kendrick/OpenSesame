import { type FormEvent, useId, useState } from "react";
import { localGitToConnection } from "../../lib/connections-local-git.js";
import {
  type Connection,
  ConnectionsError,
  type Provider,
  createConnection,
  setConnectionConfiguration,
} from "../../lib/connections.js";
import {
  type GitAuthFields,
  type GitAuthMode,
  gitAuthReady,
  gitConfigurationPayload,
  gitConfigurationSet,
} from "../../lib/git-auth-modes.js";
import {
  isLocalGitRemoteId,
  rememberLocalGitRemote,
} from "../../lib/git-remote-local.js";
import { bindHistoryConnection } from "../../lib/history-backups.js";
import type { GitConnectFieldsModel } from "./GitConnectFields.js";
import type { Flash } from "./shared.js";
import { errorText } from "./shared.js";

type GitConnectPersistInput = GitAuthFields & {
  provider: Provider;
  name: string;
};

function hostUnavailable<Thrown>(error: Thrown): boolean {
  if (error instanceof TypeError) return true;
  return (
    error instanceof ConnectionsError &&
    (error.code === "unreachable" || error.status === 0)
  );
}

async function persistGitRemote(
  input: GitConnectPersistInput,
): Promise<Connection> {
  const configuration = gitConfigurationPayload(input);
  const displayName = input.name.trim() || input.provider.displayName;

  let hostCreated = false;
  try {
    const connection = await createConnection({
      providerId: input.provider.id,
      displayName,
    });
    hostCreated = true;
    await setConnectionConfiguration(
      connection.connectionId,
      gitConfigurationSet(configuration),
    );
    bindHistoryConnection(
      input.provider.id,
      connection.connectionId,
      input.remoteUrl,
    );
    return connection;
  } catch (error) {
    // Local fallback only when Host was never reached — not after a partial create.
    if (hostCreated || !hostUnavailable(error)) throw error;
  }

  const remote = await rememberLocalGitRemote({
    displayName,
    configuration,
  });
  bindHistoryConnection(input.provider.id, remote.id, input.remoteUrl);
  return localGitToConnection(remote);
}

export function useGitConnectForm({
  provider,
  onFlash,
  onConnected,
  onRememberOffer,
}: {
  provider: Provider;
  /** Accepted for ConnectForm parity; local remotes save offline. */
  online: boolean;
  onFlash: (flash: Flash) => void;
  onConnected: () => void;
  onRememberOffer?: (connection: Connection) => void;
}): GitConnectFieldsModel {
  const nameId = useId();
  const [name, setName] = useState(provider.displayName);
  const [remoteUrl, setRemoteUrl] = useState("");
  const [authMode, setAuthMode] = useState<GitAuthMode>("https_token");
  const [username, setUsername] = useState("");
  const [token, setToken] = useState("");
  const [password, setPassword] = useState("");
  const [sshKey, setSshKey] = useState("");
  const [sshPassphrase, setSshPassphrase] = useState("");
  const [busy, setBusy] = useState(false);
  const canSave = gitAuthReady(
    authMode,
    remoteUrl,
    username,
    token,
    password,
    sshKey,
  );

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!canSave) return;
    setBusy(true);
    let created = false;
    try {
      const connection = await persistGitRemote({
        provider,
        name,
        remoteUrl,
        authMode,
        username,
        token,
        password,
        sshKey,
        sshPassphrase,
      });
      created = true;
      setToken("");
      setPassword("");
      setSshKey("");
      setSshPassphrase("");
      onFlash({ tone: "ok", text: "Git remote saved." });
      // Local remotes already seal credentials in the vault — no reminder offer.
      if (!isLocalGitRemoteId(connection.connectionId)) {
        onRememberOffer?.(connection);
      }
      onConnected();
    } catch (error) {
      onFlash({ tone: "err", text: errorText(error) });
      if (created) onConnected();
    } finally {
      setBusy(false);
    }
  }

  return {
    nameId,
    name,
    remoteUrl,
    authMode,
    username,
    token,
    password,
    sshKey,
    sshPassphrase,
    busy,
    canSave,
    onName: setName,
    onRemoteUrl: setRemoteUrl,
    onAuthMode: setAuthMode,
    onUsername: setUsername,
    onToken: setToken,
    onPassword: setPassword,
    onSshKey: setSshKey,
    onSshPassphrase: setSshPassphrase,
    onSubmit: (event) => void save(event),
  };
}
