export const GIT_AUTH_MODES = [
  { id: "https_token", label: "HTTPS token" },
  { id: "https_basic", label: "HTTPS username + password" },
  { id: "ssh_key", label: "SSH private key" },
  { id: "ssh_agent", label: "SSH agent" },
] as const;

export type GitAuthMode = (typeof GIT_AUTH_MODES)[number]["id"];

export type GitRemoteConfiguration = {
  remote_url: string;
  auth_mode: GitAuthMode;
  username?: string;
  token?: string;
  password?: string;
  ssh_private_key?: string;
  ssh_passphrase?: string;
};

export type GitAuthFields = {
  remoteUrl: string;
  authMode: GitAuthMode;
  username: string;
  token: string;
  password: string;
  sshKey: string;
  sshPassphrase: string;
};

export function isGitAuthMode(value: string): value is GitAuthMode {
  return GIT_AUTH_MODES.some((mode) => mode.id === value);
}

/** Accept HTTPS, SSH scp-style, and ssh:// clone URLs. */
export function isGitRemoteUrl(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed === "") return false;
  if (/^https?:\/\//i.test(trimmed) || /^ssh:\/\//i.test(trimmed)) {
    try {
      return new URL(trimmed).hostname !== "";
    } catch {
      return false;
    }
  }
  return /^git@[\w.-]+:\S+$/.test(trimmed);
}

export function gitAuthReady(
  authMode: GitAuthMode,
  remoteUrl: string,
  username: string,
  token: string,
  password: string,
  sshKey: string,
): boolean {
  if (!isGitRemoteUrl(remoteUrl)) return false;
  if (authMode === "ssh_agent") return true;
  if (authMode === "https_token") return token.trim() !== "";
  if (authMode === "https_basic") {
    return username.trim() !== "" && password.trim() !== "";
  }
  return sshKey.trim() !== "";
}

export function gitConfigurationPayload(
  input: GitAuthFields,
): GitRemoteConfiguration {
  const configuration: GitRemoteConfiguration = {
    remote_url: input.remoteUrl.trim(),
    auth_mode: input.authMode,
  };
  if (input.username.trim() !== "") {
    configuration.username = input.username.trim();
  }
  if (input.authMode === "https_token" && input.token.trim() !== "") {
    configuration.token = input.token.trim();
  }
  if (input.authMode === "https_basic" && input.password.trim() !== "") {
    configuration.password = input.password.trim();
  }
  if (input.authMode === "ssh_key") {
    if (input.sshKey.trim() !== "") {
      configuration.ssh_private_key = input.sshKey.trim();
    }
    if (input.sshPassphrase.trim() !== "") {
      configuration.ssh_passphrase = input.sshPassphrase.trim();
    }
  }
  return configuration;
}

/** Flatten optional keys for the connection configuration_set map. */
export function gitConfigurationSet(configuration: GitRemoteConfiguration) {
  const entries: Array<[string, string]> = [
    ["remote_url", configuration.remote_url],
    ["auth_mode", configuration.auth_mode],
  ];
  if (configuration.username !== undefined) {
    entries.push(["username", configuration.username]);
  }
  if (configuration.token !== undefined) {
    entries.push(["token", configuration.token]);
  }
  if (configuration.password !== undefined) {
    entries.push(["password", configuration.password]);
  }
  if (configuration.ssh_private_key !== undefined) {
    entries.push(["ssh_private_key", configuration.ssh_private_key]);
  }
  if (configuration.ssh_passphrase !== undefined) {
    entries.push(["ssh_passphrase", configuration.ssh_passphrase]);
  }
  return Object.fromEntries(entries);
}
