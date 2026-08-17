import { describe, expect, it } from "vitest";
import {
  DEFAULT_PASSWORD_REPO_NAME,
  defaultCreateRepoRequest,
  remoteFromRepo,
} from "./github-history.js";

describe("github history capability", () => {
  it("defaults password-store remotes to a private repo name", () => {
    const req = defaultCreateRepoRequest();
    expect(req.name).toBe(DEFAULT_PASSWORD_REPO_NAME);
    expect(req.private).toBe(true);
    expect(req.description.toLowerCase()).toMatch(/private/);
  });

  it("uses https clone URLs as the sealed-store remote", () => {
    expect(
      remoteFromRepo({
        fullName: "alice/opensesame-passwords",
        name: "opensesame-passwords",
        private: true,
        cloneUrl: "https://github.com/alice/opensesame-passwords.git",
        htmlUrl: "https://github.com/alice/opensesame-passwords",
        defaultBranch: "main",
      }),
    ).toBe("https://github.com/alice/opensesame-passwords.git");
  });
});
