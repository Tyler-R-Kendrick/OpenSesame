/** Independent scoped installation grants, repository state and immutable ciphertext commits. */
import { createHash, randomBytes } from "node:crypto";
export const OWNER = "fixture-owner";
const FILE = "opensesame-vault.backup.json";
export const digest = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");
const blob = (bytes) =>
  createHash("sha1")
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest("hex");
export const opaque = () => randomBytes(24).toString("hex");
export function requireValue(condition, status, message) {
  if (!condition) throw Object.assign(new Error(message), { status });
}
export function canonical(value) {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(value).sort(([a], [b]) => a.localeCompare(b)),
    ),
  );
}
function deferred() {
  let resolve = () => {};
  const promise = new Promise((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
export class GithubBrowserRepositories {
  repos = new Map();
  rows = [];
  errors = [];
  nextRepo = 900;
  held = null;
  holds = new Set();
  constructor() {
    this.addRepo("existing-private");
  }
  addRepo(name) {
    const record = {
      id: ++this.nextRepo,
      name,
      full_name: `${OWNER}/${name}`,
      private: true,
      default_branch: "main",
      owner: { login: OWNER },
      archived: false,
      disabled: false,
    };
    this.repos.set(name, {
      record,
      bytes: null,
      head: createHash("sha1").update(`init:${name}`).digest("hex"),
      commits: new Map(),
      putCount: 0,
    });
    return record;
  }
  grant(authorization, permission, repoName) {
    requireValue(
      String(authorization).startsWith("Bearer "),
      401,
      "Missing installation bearer token",
    );
    const value = this.tokens.get(
      String(authorization).replace(/^Bearer /, ""),
    );
    requireValue(
      value && value.expires > Date.now(),
      401,
      "Unknown installation token",
    );
    requireValue(
      value.app.installed &&
        value.permissions[permission] &&
        (!repoName ||
          !value.repositories ||
          value.repositories.includes(repoName)),
      403,
      "Installation grant refused",
    );
    return value;
  }
  mint(app, installationId, body) {
    requireValue(
      app.installed && app.installationId === Number(installationId),
      403,
      "Wrong installation owner",
    );
    const keys = Object.keys(body).sort().join(",");
    const permissions = canonical(body.permissions ?? {});
    let purpose = "list";
    if (permissions === canonical({ metadata: "read" }))
      requireValue(keys === "permissions", 400, "Unexpected list grant");
    else if (
      permissions === canonical({ metadata: "read", administration: "write" })
    ) {
      purpose = "create";
      requireValue(keys === "permissions", 400, "Unexpected create grant");
    } else if (
      permissions === canonical({ metadata: "read", contents: "read" })
    ) {
      // Reading the backup or its branch head asks for no more than read.
      purpose = "read";
      requireValue(
        keys === "permissions,repositories" &&
          Array.isArray(body.repositories) &&
          body.repositories.length === 1 &&
          this.repos.has(body.repositories[0]),
        403,
        "Wrong read grant",
      );
    } else {
      purpose = "backup";
      requireValue(
        permissions === canonical({ metadata: "read", contents: "write" }) &&
          keys === "permissions,repositories" &&
          Array.isArray(body.repositories) &&
          body.repositories.length === 1 &&
          this.repos.has(body.repositories[0]),
        403,
        "Wrong backup grant",
      );
    }
    const token = `ghs_${opaque()}`;
    const expires = Date.now() + 600000;
    this.tokens.set(token, {
      app,
      purpose,
      permissions: body.permissions,
      repositories: body.repositories,
      expires,
    });
    return {
      status: 201,
      value: { token, expires_at: new Date(expires).toISOString() },
    };
  }
  cipher(bytes) {
    requireValue(
      bytes.length > 0 && bytes.length <= 524288,
      400,
      "Invalid encrypted backup size",
    );
    const text = bytes.toString("utf8");
    const envelope = JSON.parse(text);
    requireValue(
      envelope.format === "opensesame-offline-backup" &&
        envelope.v === 1 &&
        envelope.deploymentSealUsed === false,
      400,
      "Invalid encrypted backup envelope",
    );
    requireValue(
      envelope.vault?.header?.v === 1 &&
        envelope.vault.body?.ivB64 &&
        envelope.vault.body?.ctB64,
      400,
      "Missing vault ciphertext",
    );
    requireValue(
      Buffer.from(envelope.vault.body.ivB64, "base64").length === 12 &&
        Buffer.from(envelope.vault.body.ctB64, "base64").length > 16,
      400,
      "Invalid vault ciphertext",
    );
    for (const field of [
      '"plaintext"',
      '"password":',
      '"secret":',
      '"token":',
      "OPENSESAME_CONNECTION_KEY",
    ])
      requireValue(!text.includes(field), 400, "Plaintext in backup request");
    this.assertNoSecret(text);
  }
  async contents(repo, method, body, url, response) {
    if (method === "PUT") {
      requireValue(
        body.branch === "main" &&
          body.sha === (repo.bytes ? blob(repo.bytes) : undefined),
        409,
        "Conditional backup SHA changed",
      );
      const bytes = Buffer.from(body.content ?? "", "base64");
      requireValue(
        bytes.toString("base64") === body.content,
        400,
        "Invalid canonical backup encoding",
      );
      this.cipher(bytes);
      repo.bytes = bytes;
      repo.head = createHash("sha1")
        .update(bytes)
        .update(String(++repo.putCount))
        .digest("hex");
      repo.commits.set(repo.head, Buffer.from(bytes));
      return { status: 201, value: { commit: { sha: repo.head } } };
    }
    requireValue(method === "GET", 405, "Invalid Contents method");
    const held = this.held;
    if (held) {
      this.held = null;
      response.once("close", held.closed.resolve);
      held.seen.resolve();
      await Promise.race([held.gate.promise, held.closed.promise]);
      this.holds.delete(held);
      if (response.destroyed) return null;
    }
    const ref = url.searchParams.get("ref");
    const bytes = ref === "main" ? repo.bytes : repo.commits.get(ref);
    if (!bytes) return { status: 404, value: {} };
    return {
      status: 200,
      value: {
        type: "file",
        path: FILE,
        sha: blob(bytes),
        encoding: "base64",
        size: bytes.length,
        content: bytes.toString("base64"),
      },
    };
  }
  conversion(conversion) {
    const app = this.codes.get(conversion[1]);
    requireValue(app, 404, "Unknown or consumed manifest conversion");
    this.codes.delete(conversion[1]);
    this.conversions++;
    return {
      status: 201,
      value: {
        ...this.appValue(app),
        client_secret: app.clientSecret,
        pem: app.pem,
      },
    };
  }
  appRequest(method, path, headers, body) {
    const app = this.jwt(headers.authorization);
    if (path === "/app" && method === "GET")
      return { status: 200, value: this.appValue(app) };
    if (path === "/app/installations" && method === "GET")
      return {
        status: 200,
        value: app.installed ? [this.installation(app)] : [],
      };
    const install = /^\/app\/installations\/(\d+)(\/access_tokens)?$/.exec(
      path,
    );
    requireValue(
      install && Number(install[1]) === app.installationId && app.installed,
      403,
      "Wrong App installation",
    );
    if (install[2] && method === "POST")
      return this.mint(app, install[1], body);
    if (!install[2] && method === "GET")
      return { status: 200, value: this.installation(app) };
  }
  repositoryList(method, path, headers, body) {
    if (path === "/installation/repositories" && method === "GET") {
      this.grant(headers.authorization, "metadata");
      return {
        status: 200,
        value: {
          total_count: this.repos.size,
          repositories: [...this.repos.values()].map((repo) => repo.record),
        },
      };
    }
    if (path === "/user/repos" && method === "POST") {
      this.grant(headers.authorization, "administration");
      requireValue(
        body.private === true &&
          body.auto_init === true &&
          /^[A-Za-z0-9_.-]{1,100}$/.test(body.name) &&
          !this.repos.has(body.name),
        409,
        "Invalid new private repository",
      );
      return { status: 201, value: this.addRepo(body.name) };
    }
  }
  repository(method, url, headers, body, response) {
    const path = url.pathname;
    const match = /^\/repos\/fixture-owner\/([^/]+)(.*)$/.exec(path);
    requireValue(
      match && this.repos.has(match[1]),
      404,
      "Unknown fixture repository",
    );
    const repo = this.repos.get(match[1]);
    const grant = this.grant(
      headers.authorization,
      match[2].startsWith("/contents/") || match[2].startsWith("/git/")
        ? "contents"
        : "metadata",
      repo.record.name,
    );
    requireValue(
      method !== "PUT" || grant.permissions.contents === "write",
      403,
      "Installation grant refused",
    );
    if (!match[2] && method === "GET")
      return { status: 200, value: repo.record };
    if (match[2] === "/git/ref/heads/main" && method === "GET")
      return {
        status: 200,
        value: {
          ref: "refs/heads/main",
          object: { type: "commit", sha: repo.head },
        },
      };
    requireValue(
      match[2] === `/contents/${FILE}`,
      404,
      "Unexpected repository path",
    );
    return this.contents(repo, method, body, url, response);
  }
  async api(method, url, headers, raw, response) {
    const path = url.pathname;
    const body = raw ? JSON.parse(raw) : {};
    const conversion = /^\/app-manifests\/([A-Za-z0-9_-]+)\/conversions$/.exec(
      path,
    );
    if (conversion && method === "POST") return this.conversion(conversion);
    if (path.startsWith("/app")) {
      const result = this.appRequest(method, path, headers, body);
      if (result) return result;
    }
    const result = this.repositoryList(method, path, headers, body);
    if (result) return result;
    return this.repository(method, url, headers, body, response);
  }
  snapshot(name) {
    const repo = this.repos.get(name);
    return {
      exists: !!repo,
      head: repo?.head ?? null,
      sha256: repo?.bytes ? digest(repo.bytes) : null,
      putCount: repo?.putCount ?? 0,
      bytes: repo?.bytes?.length ?? 0,
    };
  }
  holdNextRead() {
    requireValue(!this.held, 409, "A provider read is already held");
    const held = { seen: deferred(), gate: deferred(), closed: deferred() };
    this.held = held;
    this.holds.add(held);
    return {
      seen: held.seen.promise,
      release: held.gate.resolve,
      closed: held.closed.promise,
    };
  }
  summary() {
    return {
      apps: this.apps.size,
      conversions: this.conversions,
      installs: [...this.apps.values()].filter((app) => app.installed).length,
      validAppJwtChecks: this.jwtChecks,
      mintedTokens: Object.fromEntries(
        ["list", "create", "read", "backup"].map((purpose) => [
          purpose,
          [...this.tokens.values()].filter((token) => token.purpose === purpose)
            .length,
        ]),
      ),
      creates: this.repos.size - 1,
      puts: [...this.repos.values()].reduce(
        (sum, repo) => sum + repo.putCount,
        0,
      ),
      reads: this.rows.filter(
        (row) => row.method === "GET" && row.path.includes(`/contents/${FILE}`),
      ).length,
      errors: [...this.errors],
      rowCount: this.rows.length,
    };
  }
}
