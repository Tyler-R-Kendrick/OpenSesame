import { describe, expect, it } from "vitest";
import {
  gitAuthReady,
  gitConfigurationPayload,
  gitConfigurationSet,
  isGitRemoteUrl,
} from "./git-auth-modes.js";

describe("git-auth-modes", () => {
  it("accepts HTTPS and SSH remote URLs", () => {
    expect(isGitRemoteUrl("https://git.example/a.git")).toBe(true);
    expect(isGitRemoteUrl("git@host:org/repo.git")).toBe(true);
    expect(isGitRemoteUrl("ssh://git@host/org/repo.git")).toBe(true);
    expect(isGitRemoteUrl("not-a-url")).toBe(false);
  });

  it("requires credentials for each auth mode except ssh_agent", () => {
    expect(
      gitAuthReady("https_token", "https://git.example/a.git", "", "", "", ""),
    ).toBe(false);
    expect(
      gitAuthReady(
        "https_token",
        "https://git.example/a.git",
        "",
        "tok",
        "",
        "",
      ),
    ).toBe(true);
    expect(
      gitAuthReady(
        "https_basic",
        "https://git.example/a.git",
        "u",
        "",
        "p",
        "",
      ),
    ).toBe(true);
    expect(
      gitAuthReady("ssh_key", "git@host:org/repo.git", "", "", "", "KEY"),
    ).toBe(true);
    expect(
      gitAuthReady("ssh_agent", "git@host:org/repo.git", "", "", "", ""),
    ).toBe(true);
  });

  it("builds forge-agnostic configuration for each auth mode", () => {
    expect(
      gitConfigurationSet(
        gitConfigurationPayload({
          remoteUrl: "https://git.example/a.git",
          authMode: "https_token",
          username: "git",
          token: "glpat-x",
          password: "",
          sshKey: "",
          sshPassphrase: "",
        }),
      ),
    ).toEqual({
      remote_url: "https://git.example/a.git",
      auth_mode: "https_token",
      username: "git",
      token: "glpat-x",
    });

    expect(
      gitConfigurationSet(
        gitConfigurationPayload({
          remoteUrl: "https://git.example/a.git",
          authMode: "https_basic",
          username: "alice",
          token: "",
          password: "secret",
          sshKey: "",
          sshPassphrase: "",
        }),
      ),
    ).toEqual({
      remote_url: "https://git.example/a.git",
      auth_mode: "https_basic",
      username: "alice",
      password: "secret",
    });

    expect(
      gitConfigurationSet(
        gitConfigurationPayload({
          remoteUrl: "git@host:org/repo.git",
          authMode: "ssh_key",
          username: "",
          token: "",
          password: "",
          sshKey: "-----BEGIN OPENSSH PRIVATE KEY-----",
          sshPassphrase: "phrase",
        }),
      ),
    ).toEqual({
      remote_url: "git@host:org/repo.git",
      auth_mode: "ssh_key",
      ssh_private_key: "-----BEGIN OPENSSH PRIVATE KEY-----",
      ssh_passphrase: "phrase",
    });

    expect(
      gitConfigurationSet(
        gitConfigurationPayload({
          remoteUrl: "ssh://git@host/org/repo.git",
          authMode: "ssh_agent",
          username: "",
          token: "",
          password: "",
          sshKey: "",
          sshPassphrase: "",
        }),
      ),
    ).toEqual({
      remote_url: "ssh://git@host/org/repo.git",
      auth_mode: "ssh_agent",
    });
  });
});
