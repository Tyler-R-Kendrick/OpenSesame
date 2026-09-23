import { putBackupTarget } from "@opensesame/app-core/lib/backup.js";
import { localGitToConnection } from "@opensesame/app-core/lib/connections-local-git.js";
import {
  type Connection,
  type Provider,
  createConnection,
  setConnectionConfiguration,
} from "@opensesame/app-core/lib/connections.js";
import {
  type GitAuthFields,
  type GitAuthMode,
  gitAuthReady,
  gitConfigurationPayload,
  gitConfigurationSet,
} from "@opensesame/app-core/lib/git-auth-modes.js";
import { ownerRepoFromGitRemote } from "@opensesame/app-core/lib/git-backup-forges.js";
import {
  isLocalGitRemoteId,
  rememberLocalGitRemote,
} from "@opensesame/app-core/lib/git-remote-local.js";
import { bindHistoryConnection } from "@opensesame/app-core/lib/history-backups.js";
import type { Flash } from "@opensesame/app-core/sections/connections/shared.js";
import { errorText } from "@opensesame/app-core/sections/connections/shared.js";
import { type FormEvent, useId, useState } from "react";
import type { GitConnectFieldsModel } from "./GitConnectFields.js";

type GitConnectPersistInput = GitAuthFields & {
  provider: Provider;
  name: string;
};

async function bindBackupRemote(
  providerId: string,
  connectionId: string,
  remoteUrl: string,
): Promise<void> {
  const parsed = ownerRepoFromGitRemote(remoteUrl);
  if (!parsed) return;
  await putBackupTarget({
    kind: "git_remote",
    providerId,
    connectionId,
    owner: parsed.owner,
    repo: parsed.repo,
    branch: "main",
    enabled: true,
    config: { remoteUrl },
  });
}

async function persistGitRemote(
  input: GitConnectPersistInput,
): Promise<Connection> {
  const configuration = gitConfigurationPayload(input);
  const displayName = input.name.trim() || input.provider.displayName;

  // SPA-first: seal the remote on this device. Optional gateway create is a
  // best-effort upgrade when a deployment still speaks one.
  const remote = await rememberLocalGitRemote({
    displayName,
    configuration,
  });
  bindHistoryConnection(input.provider.id, remote.id, input.remoteUrl);
  await bindBackupRemote(input.provider.id, remote.id, input.remoteUrl);

  // Optional gateway mirror — never required for SPA backup.
  try {
    const connection = await createConnection({
      providerId: input.provider.id,
      displayName,
    });
    await setConnectionConfiguration(
      connection.connectionId,
      gitConfigurationSet(configuration),
    );
  } catch {
    // Local remote + vault credentials are enough.
  }

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
