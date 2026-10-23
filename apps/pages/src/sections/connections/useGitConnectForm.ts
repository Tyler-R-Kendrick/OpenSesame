import { putBackupTarget } from "@opensesame/app-core/lib/backup.js";
import type {
  Connection,
  Provider,
} from "@opensesame/app-core/lib/connections.js";
import { saveForgeConnector } from "@opensesame/app-core/lib/device-connectors.js";
import {
  type GitAuthFields,
  type GitAuthMode,
  gitAuthReady,
  gitConfigurationPayload,
} from "@opensesame/app-core/lib/git-auth-modes.js";
import { ownerRepoFromGitRemote } from "@opensesame/app-core/lib/git-backup-forges.js";
import { isLocalGitRemoteId } from "@opensesame/app-core/lib/git-remote-local.js";
import type { Flash } from "@opensesame/app-core/sections/connections/shared.js";
import { errorText } from "@opensesame/app-core/sections/connections/shared.js";
import { type FormEvent, useId, useState } from "react";
import type { GitConnectFieldsModel } from "./GitConnectFields.js";

type GitConnectPersistInput = GitAuthFields & {
  provider: Provider;
  name: string;
};

/** A backup target needs the address, never the credential in its userinfo. */
function sanitizedRemote(remoteUrl: string): string {
  try {
    const url = new URL(remoteUrl);
    if (url.username || url.password) {
      url.username = "";
      url.password = "";
    }
    return url.href;
  } catch {
    return remoteUrl;
  }
}

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
    config: { remoteUrl: sanitizedRemote(remoteUrl) },
  });
}

type GitConnectPersistResult = {
  connection: Connection;
  bindError: unknown;
};

async function persistGitRemote(
  input: GitConnectPersistInput,
): Promise<GitConnectPersistResult> {
  const configuration = gitConfigurationPayload(input);
  const displayName = input.name.trim() || input.provider.displayName;
  const connection = await saveForgeConnector(input.provider, {
    displayName,
    configuration,
  });
  try {
    await bindBackupRemote(
      input.provider.id,
      connection.connectionId,
      input.remoteUrl,
    );
    return { connection, bindError: null };
  } catch (bindError) {
    // The connector is already saved and its credentials sealed. Letting the
    // whole save fail here would invite a retry that creates a second
    // connector for the same remote.
    return { connection, bindError };
  }
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
      const { connection, bindError } = await persistGitRemote({
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
      onFlash(
        bindError === null
          ? { tone: "ok", text: "Git remote saved." }
          : {
              tone: "warn",
              text: `Git remote saved, but its backup target could not be bound: ${errorText(bindError)}`,
            },
      );
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
