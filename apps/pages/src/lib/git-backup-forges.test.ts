import { describe, expect, it } from "vitest";
import {
  forgeForProvider,
  forgeFromRemoteUrl,
  isGitBackupProvider,
  ownerRepoFromGitRemote,
} from "./git-backup-forges.js";

describe("git-backup-forges", () => {
  it("recognizes configurable forge backends", () => {
    expect(isGitBackupProvider("gitlab")).toBe(true);
    expect(isGitBackupProvider("bitbucket")).toBe(true);
    expect(isGitBackupProvider("codeberg")).toBe(true);
    expect(isGitBackupProvider("origin")).toBe(true);
    expect(isGitBackupProvider("git")).toBe(true);
    expect(isGitBackupProvider("github")).toBe(false);
  });

  it("parses owner/repo from forge clone URLs", () => {
    expect(ownerRepoFromGitRemote("https://gitlab.com/acme/vault.git")).toEqual(
      { owner: "acme", repo: "vault" },
    );
    expect(
      ownerRepoFromGitRemote("https://bitbucket.org/acme/vault.git"),
    ).toEqual({ owner: "acme", repo: "vault" });
    expect(
      ownerRepoFromGitRemote("https://codeberg.org/acme/vault.git"),
    ).toEqual({ owner: "acme", repo: "vault" });
    expect(ownerRepoFromGitRemote("git@gitlab.com:acme/vault.git")).toEqual({
      owner: "acme",
      repo: "vault",
    });
  });

  it("maps providers and remotes to forge dialects", () => {
    expect(forgeForProvider("gitlab")).toBe("gitlab");
    expect(forgeForProvider("bitbucket")).toBe("bitbucket");
    expect(forgeForProvider("codeberg")).toBe("codeberg");
    expect(forgeForProvider("origin")).toBe("origin");
    expect(forgeFromRemoteUrl("https://codeberg.org/a/b.git")).toBe("codeberg");
    expect(forgeFromRemoteUrl("https://origin.cursor.com/a/b.git")).toBe(
      "origin",
    );
  });
});
