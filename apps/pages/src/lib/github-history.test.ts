import type { BoundaryValue } from "@opensesame/os-domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultCapabilityConnectors } from "./capabilities.js";
import {
  DEFAULT_PASSWORD_REPO_NAME,
  createGithubPasswordRepo,
  defaultCreateRepoRequest,
  listGithubRepos,
  remoteFromRepo,
} from "./github-history.js";
import { clearHostSession, clearSession } from "./identity.js";
import { saveSettings, shippedHostApi } from "./settings.js";

const HOST = shippedHostApi;

function jsonResponse(body: BoundaryValue, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Host-local loopback session + handler for the GitHub capability endpoints. */
function stubHost(handler: (url: string, init?: RequestInit) => Response) {
  const spy = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === `${HOST}/api/v1/session/local`) {
      return Promise.resolve(
        jsonResponse({
          access_token: "opaque-session:sess_local",
          expires_in: 28_800,
          local_session: true,
        }),
      );
    }
    return Promise.resolve(handler(url, init));
  });
  vi.stubGlobal("fetch", spy);
  return spy;
}

const REPO_URL = (id: string) =>
  `${HOST}/api/v1/connections/${id}/github/repos`;

beforeEach(() => {
  clearSession();
  clearHostSession();
  saveSettings({
    hostApi: HOST,
    identityApi: "",
    daemonApi: "",
    tursoUrl: "",
    mfaAppUrl: "",
    capabilityConnectors: {
      ...defaultCapabilityConnectors(),
      encryption: { providerId: "webcrypto" },
      history: { providerId: "github" },
    },
  });
});

afterEach(() => {
  clearSession();
  clearHostSession();
  vi.unstubAllGlobals();
});

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

describe("listGithubRepos", () => {
  it("maps repositories and keeps only https clone URLs", async () => {
    stubHost((url) => {
      expect(url).toBe(REPO_URL("conn_1"));
      return jsonResponse({
        repositories: [
          {
            full_name: "acme/store",
            name: "store",
            private: true,
            clone_url: "https://github.com/acme/store.git",
            html_url: "https://github.com/acme/store",
            default_branch: "main",
          },
          {
            full_name: "acme/ssh-only",
            name: "ssh-only",
            private: true,
            clone_url: "git@github.com:acme/ssh-only.git",
            html_url: "https://github.com/acme/ssh-only",
          },
          null,
          "garbage",
        ],
      });
    });

    const repos = await listGithubRepos("conn_1");

    expect(repos).toHaveLength(1);
    expect(repos[0]).toMatchObject({
      fullName: "acme/store",
      private: true,
      defaultBranch: "main",
    });
  });

  it("treats a missing repositories field as an empty list", async () => {
    stubHost(() => jsonResponse({}));
    await expect(listGithubRepos("conn_1")).resolves.toEqual([]);
  });

  it("surfaces the Host hint when listing fails", async () => {
    stubHost(() =>
      jsonResponse({ error: "forbidden", hint: "Reconnect GitHub." }, 403),
    );
    await expect(listGithubRepos("conn_1")).rejects.toThrowError(
      "Reconnect GitHub.",
    );
  });

  it("falls back to the error field, then to the status", async () => {
    stubHost(() => jsonResponse({ error: "rate_limited" }, 429));
    await expect(listGithubRepos("conn_1")).rejects.toThrowError(
      "rate_limited",
    );

    clearHostSession();
    stubHost(() => jsonResponse({}, 500));
    await expect(listGithubRepos("conn_1")).rejects.toThrowError(
      "Could not list GitHub repos (500)",
    );

    clearHostSession();
    stubHost(() => new Response("not json", { status: 502 }));
    await expect(listGithubRepos("conn_1")).rejects.toThrowError(
      "Could not list GitHub repos (502)",
    );
  });
});

describe("createGithubPasswordRepo", () => {
  it("creates a private repo with the default name and description", async () => {
    const spy = stubHost(() =>
      jsonResponse({
        full_name: "acme/opensesame-passwords",
        name: "opensesame-passwords",
        private: true,
        clone_url: "https://github.com/acme/opensesame-passwords.git",
        html_url: "https://github.com/acme/opensesame-passwords",
        default_branch: "main",
      }),
    );

    const repo = await createGithubPasswordRepo("conn_1");

    expect(repo.name).toBe(DEFAULT_PASSWORD_REPO_NAME);
    const request = spy.mock.calls.find(([url]) => url === REPO_URL("conn_1"));
    expect(request?.[1]?.method).toBe("POST");
    expect(JSON.parse(String(request?.[1]?.body))).toEqual({
      name: DEFAULT_PASSWORD_REPO_NAME,
      private: true,
      description:
        "OpenSesame sealed-store ciphertext (passwords) — private by default",
    });
  });

  it("honors a custom name and description, trimming blanks back to default", async () => {
    const spy = stubHost(() =>
      jsonResponse({
        full_name: "acme/custom",
        name: "custom",
        private: true,
        clone_url: "https://github.com/acme/custom.git",
        html_url: "https://github.com/acme/custom",
        default_branch: "main",
      }),
    );

    await createGithubPasswordRepo("conn_1", {
      name: "  ",
      description: "my store",
    });
    expect(
      JSON.parse(
        String(
          spy.mock.calls.find(([url]) => url === REPO_URL("conn_1"))?.[1]?.body,
        ),
      ),
    ).toMatchObject({
      name: DEFAULT_PASSWORD_REPO_NAME,
      description: "my store",
    });

    await createGithubPasswordRepo("conn_1", { name: "custom" });
    const calls = spy.mock.calls.filter(([url]) => url === REPO_URL("conn_1"));
    expect(JSON.parse(String(calls.at(-1)?.[1]?.body)).name).toBe("custom");
  });

  it("surfaces the Host hint when creation fails", async () => {
    stubHost(() => jsonResponse({ hint: "Name already taken." }, 422));
    await expect(createGithubPasswordRepo("conn_1")).rejects.toThrowError(
      "Name already taken.",
    );
  });

  it("falls back to the status when the error body has no detail", async () => {
    stubHost(() => jsonResponse({}, 500));
    await expect(createGithubPasswordRepo("conn_1")).rejects.toThrowError(
      "Could not create GitHub repo (500)",
    );
  });

  it("refuses a repo without an https clone URL", async () => {
    stubHost(() =>
      jsonResponse({
        full_name: "acme/store",
        name: "store",
        private: true,
        clone_url: "git@github.com:acme/store.git",
      }),
    );
    await expect(createGithubPasswordRepo("conn_1")).rejects.toThrowError(
      "without an https clone URL",
    );
  });

  it("refuses a public repo when a private one was requested", async () => {
    stubHost(() =>
      jsonResponse({
        full_name: "acme/store",
        name: "store",
        private: false,
        clone_url: "https://github.com/acme/store.git",
      }),
    );
    await expect(createGithubPasswordRepo("conn_1")).rejects.toThrowError(
      "Expected a private repository",
    );
  });

  it("accepts a public repo only when explicitly requested", async () => {
    stubHost(() =>
      jsonResponse({
        full_name: "acme/public-store",
        name: "public-store",
        private: false,
        clone_url: "https://github.com/acme/public-store.git",
      }),
    );
    await expect(
      createGithubPasswordRepo("conn_1", { private: false }),
    ).resolves.toMatchObject({ private: false });
  });
});

describe("remoteFromRepo", () => {
  it("trims a trailing slash", () => {
    expect(
      remoteFromRepo({
        fullName: "acme/store",
        name: "store",
        private: true,
        cloneUrl: "https://github.com/acme/store.git/",
        htmlUrl: "https://github.com/acme/store",
        defaultBranch: "main",
      }),
    ).toBe("https://github.com/acme/store.git");
  });
});
