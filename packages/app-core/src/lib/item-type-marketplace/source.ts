/**
 * A marketplace of vault item types is a git repository (ADR 0134).
 *
 * This module turns what a person types — `owner/repo`, a forge URL, an scp
 * remote, a `gitlab+https://…` self-hosted address, or the raw address of a
 * marketplace index — into one of five readable shapes, and builds the one
 * kind of URL the page ever fetches from it: a raw file at a fixed ref.
 *
 * A browser cannot speak git's smart-HTTP protocol without a CORS proxy, so a
 * repository is read through its forge's raw-file endpoint instead. Every URL
 * built here is https, carries no credential, and names a path inside the
 * same repository: an index can point at files in its own tree, never at a
 * host of its choosing.
 */

export type MarketplaceForge = "github" | "gitlab" | "gitea" | "bitbucket";

export type ForgeSource = {
  readonly forge: MarketplaceForge;
  /** The forge's web host — `github.com`, `gitlab.example.com`. */
  readonly host: string;
  /** `owner/repo`; GitLab may nest groups (`group/sub/repo`). */
  readonly repo: string;
  /** A branch, tag or commit; null reads the repository's default branch. */
  readonly ref: string | null;
  /** A directory inside the repository the marketplace lives under, or "". */
  readonly root: string;
};

/** A repository served as plain files — any host, located by its index. */
export type RawSource = {
  readonly forge: "raw";
  /** The repository root, ending in `/`: the index's URL minus INDEX_PATH. */
  readonly base: string;
};

export type MarketplaceSource = ForgeSource | RawSource;

/** Where a marketplace keeps its index, relative to its root. */
export const INDEX_PATH = ".opensesame/marketplace.json";

/** Ours: the marketplace every device starts with. */
export const DEFAULT_MARKETPLACE = "github:tyler-r-kendrick/OpenSesame#main";

const SEGMENT = /^[A-Za-z0-9_.-]{1,100}$/;
const REF = /^[A-Za-z0-9_./-]{1,128}$/;
const HOST =
  /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+(:\d{1,5})?$/;
const MAX_REFERENCE = 512;

const SHORTHAND: Readonly<Record<string, readonly [MarketplaceForge, string]>> =
  {
    github: ["github", "github.com"],
    gitlab: ["gitlab", "gitlab.com"],
    codeberg: ["gitea", "codeberg.org"],
    bitbucket: ["bitbucket", "bitbucket.org"],
  };

const KNOWN_HOSTS: Readonly<Record<string, MarketplaceForge>> = {
  "github.com": "github",
  "gitlab.com": "gitlab",
  "codeberg.org": "gitea",
  "bitbucket.org": "bitbucket",
};

/** A relative path with no empty, `.` or `..` segment. */
export function isSafeRelativePath(path: string, max = 256): boolean {
  if (path === "" || path.length > max) return false;
  return path
    .split("/")
    .every((part) => SEGMENT.test(part) && part !== "." && part !== "..");
}

function cleanRef(ref: string | undefined): string | null | undefined {
  // `HEAD` is every forge's default branch: stored as "no pin", so Bitbucket
  // (whose file route has no `HEAD` alias) still resolves its main branch.
  if (ref === undefined || ref === "" || ref === "HEAD") return null;
  return REF.test(ref) && isSafeRelativePath(ref, 128) ? ref : undefined;
}

function cleanRoot(root: string | undefined): string | undefined {
  const trimmed = (root ?? "").replace(/^\/+|\/+$/g, "");
  if (trimmed === "") return "";
  return isSafeRelativePath(trimmed) ? trimmed : undefined;
}

function repoOf(
  forge: MarketplaceForge,
  segments: readonly string[],
): string | null {
  const parts = [...segments];
  const last = parts.at(-1);
  if (last !== undefined) parts[parts.length - 1] = last.replace(/\.git$/, "");
  const nests = forge === "gitlab" ? parts.length >= 2 : parts.length === 2;
  if (!nests || parts.length > 8) return null;
  if (!parts.every((part) => SEGMENT.test(part) && !/^\.+$/.test(part)))
    return null;
  return parts.join("/");
}

function forgeSource(
  forge: MarketplaceForge,
  host: string,
  segments: readonly string[],
  ref: string | undefined,
  root?: string,
): ForgeSource | null {
  const repo = repoOf(forge, segments);
  const cleanedRef = cleanRef(ref);
  const cleanedRoot = cleanRoot(root);
  if (repo === null || cleanedRef === undefined || cleanedRoot === undefined)
    return null;
  if (!HOST.test(host)) return null;
  // Their raw routes live on the public service's own hosts, so a GitHub or
  // Bitbucket source anywhere else would be read from the same-named
  // repository on the public site. A self-hosted instance is listed by the
  // raw address of its index instead.
  const only = PUBLIC_HOST_ONLY[forge];
  if (only !== undefined && host !== only) return null;
  return { forge, host, repo, ref: cleanedRef, root: cleanedRoot };
}

const PUBLIC_HOST_ONLY: Readonly<Partial<Record<MarketplaceForge, string>>> = {
  github: "github.com",
  bitbucket: "bitbucket.org",
};

/** `…/tree/<ref>/<root>` and each forge's spelling of it. */
const TREE_MARKERS: Readonly<Record<MarketplaceForge, readonly string[]>> = {
  github: ["tree", "blob", "raw"],
  gitlab: ["-"],
  gitea: ["src", "raw"],
  bitbucket: ["src"],
};

function splitTree(
  forge: MarketplaceForge,
  segments: readonly string[],
): { repo: string[]; ref?: string; root?: string } {
  const at = segments.findIndex(
    (part, index) => index >= 2 && TREE_MARKERS[forge].includes(part),
  );
  if (at < 0) return { repo: [...segments] };
  let rest = segments.slice(at + 1);
  if (forge === "gitlab" && ["tree", "blob", "raw"].includes(rest[0] ?? ""))
    rest = rest.slice(1);
  if (forge === "gitea" && ["branch", "tag", "commit"].includes(rest[0] ?? ""))
    rest = rest.slice(1);
  return {
    repo: segments.slice(0, at),
    ref: rest[0],
    root: rest.slice(1).join("/"),
  };
}

function fromUrl(url: URL, named: MarketplaceForge | undefined, ref?: string) {
  const host = url.host.toLowerCase();
  const segments = url.pathname.split("/").filter((part) => part !== "");
  const index = url.pathname.endsWith(`/${INDEX_PATH}`);
  const forge = named ?? KNOWN_HOSTS[host] ?? guessForge(host);
  if (forge === undefined) return index ? rawSource(url) : null;
  const tree = splitTree(forge, segments);
  // A link to the index file itself (`…/blob/main/.opensesame/…`) names the
  // directory the marketplace lives in, read through the forge like any other.
  const root = index
    ? (tree.root ?? "").slice(0, -INDEX_PATH.length)
    : tree.root;
  return forgeSource(forge, host, tree.repo, ref ?? tree.ref, root);
}

/** A self-hosted forge usually says which one it is in its name. */
function guessForge(host: string): MarketplaceForge | undefined {
  if (host.includes("gitlab")) return "gitlab";
  if (host.includes("gitea") || host.includes("forgejo")) return "gitea";
  return undefined;
}

function rawSource(url: URL): RawSource | null {
  if (url.search !== "" || url.hash !== "") return null;
  const base = url.href.slice(0, -INDEX_PATH.length);
  return { forge: "raw", base };
}

function httpsUrl(raw: string): URL | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    return url;
  } catch {
    return null;
  }
}

function fromPrefixed(forgeName: string, rest: string, ref?: string) {
  const forge = forgeName === "forgejo" ? "gitea" : forgeName;
  if (!["github", "gitlab", "gitea", "bitbucket"].includes(forge)) return null;
  const url = httpsUrl(rest);
  return url === null
    ? null
    : fromUrl(url, forge as MarketplaceForge, ref ?? undefined);
}

function fromScp(text: string, ref: string | undefined) {
  const match = /^git@([^:/]+):(.+)$/.exec(text);
  if (!match?.[1] || !match[2]) return null;
  const host = match[1].toLowerCase();
  const forge = KNOWN_HOSTS[host] ?? guessForge(host);
  if (forge === undefined) return null;
  return forgeSource(forge, host, match[2].split("/"), ref);
}

function fromShorthand(text: string, ref: string | undefined) {
  const match = /^([a-z]+):(?!\/\/)(.+)$/.exec(text);
  const named = match?.[1] ? SHORTHAND[match[1]] : undefined;
  const path = match ? match[2] : text;
  const [forge, host] = named ?? ["github", "github.com"];
  if (match && !named) return null;
  return forgeSource(forge, host, (path ?? "").split("/"), ref);
}

/**
 * Read a marketplace reference, or return null when this page could not read
 * it. The `#ref` suffix pins a branch, tag or commit on any form.
 */
export function parseMarketplaceSource(
  input: string,
): MarketplaceSource | null {
  const text = input.trim();
  if (text === "" || text.length > MAX_REFERENCE || /\s/.test(text))
    return null;
  const hash = text.lastIndexOf("#");
  const body = hash < 0 ? text : text.slice(0, hash);
  const ref = hash < 0 ? undefined : text.slice(hash + 1);
  if (ref === "") return null;
  const prefixed = /^([a-z]+)\+(https:\/\/.+)$/.exec(body);
  if (prefixed?.[1] && prefixed[2])
    return fromPrefixed(prefixed[1], prefixed[2], ref);
  if (body.startsWith("git@")) return fromScp(body, ref);
  if (/^[a-z]+:\/\//.test(body)) {
    const url = httpsUrl(body);
    return url === null ? null : fromUrl(url, undefined, ref);
  }
  return fromShorthand(body, ref);
}

/** How each forge's web UI spells "this directory at this ref". */
const TREE_SPELLING: Readonly<Record<MarketplaceForge, string>> = {
  github: "tree",
  gitlab: "-/tree",
  gitea: "src/branch",
  bitbucket: "src",
};

/** The one spelling a source is stored and compared under. */
export function sourceReference(source: MarketplaceSource): string {
  if (source.forge === "raw") return `${source.base}${INDEX_PATH}`;
  const shorthand = Object.entries(SHORTHAND).find(
    ([, [forge, host]]) => forge === source.forge && host === source.host,
  )?.[0];
  const where = shorthand
    ? `${shorthand}:${source.repo}`
    : `${source.forge}+https://${source.host}/${source.repo}`;
  const pin = source.ref === null ? "" : `#${source.ref}`;
  if (source.root === "") return `${where}${pin}`;
  // The directory rides a tree path at HEAD and the pin rides `#`, so a ref
  // containing `/` never runs into the directory when it is read back.
  const tree = `${TREE_SPELLING[source.forge]}/HEAD/${source.root}`;
  return `${source.forge}+https://${source.host}/${source.repo}/${tree}${pin}`;
}

/** What a row calls a source: host, repository, and the ref when pinned. */
export function sourceLabel(source: MarketplaceSource): string {
  if (source.forge === "raw") {
    const url = new URL(source.base);
    return `${url.host}${url.pathname.replace(/\/$/, "")}`;
  }
  const root = source.root === "" ? "" : `/${source.root}`;
  const ref = source.ref === null ? "" : `@${source.ref}`;
  return `${source.host}/${source.repo}${root}${ref}`;
}

/** Where a person reads the repository in a browser. */
export function sourceWebUrl(source: MarketplaceSource): string {
  if (source.forge === "raw") return source.base;
  return `https://${source.host}/${source.repo}`;
}

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

/**
 * The raw URL of `path`, relative to the marketplace root. `ref` is the
 * resolved ref (Bitbucket has no `HEAD` alias; the loader asks for the main
 * branch first).
 */
export function rawFileUrl(
  source: MarketplaceSource,
  path: string,
  ref: string | null = source.forge === "raw" ? null : source.ref,
): string {
  if (source.forge === "raw") return `${source.base}${encodePath(path)}`;
  const full = source.root === "" ? path : `${source.root}/${path}`;
  const repo = source.repo;
  switch (source.forge) {
    case "github":
      return `https://raw.githubusercontent.com/${repo}/${encodePath(ref ?? "HEAD")}/${encodePath(full)}`;
    case "gitlab":
      return `https://${source.host}/api/v4/projects/${encodeURIComponent(repo)}/repository/files/${encodeURIComponent(full)}/raw?ref=${encodeURIComponent(ref ?? "HEAD")}`;
    case "gitea":
      return `https://${source.host}/api/v1/repos/${repo}/raw/${encodePath(full)}${ref === null ? "" : `?ref=${encodeURIComponent(ref)}`}`;
    case "bitbucket":
      return `https://api.bitbucket.org/2.0/repositories/${repo}/src/${encodePath(ref ?? "HEAD")}/${encodePath(full)}`;
  }
}

/** Bitbucket names its default branch only through the repository record. */
export function bitbucketRepositoryUrl(source: ForgeSource): string {
  return `https://api.bitbucket.org/2.0/repositories/${source.repo}`;
}
