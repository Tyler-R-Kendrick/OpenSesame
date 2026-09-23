import { describe, expect, it } from "vitest";
import {
  DEFAULT_MARKETPLACE,
  INDEX_PATH,
  parseMarketplaceSource,
  rawFileUrl,
  sourceLabel,
  sourceReference,
} from "./source.js";

function parse(input: string) {
  const source = parseMarketplaceSource(input);
  if (source === null) throw new Error(`refused: ${input}`);
  return source;
}

describe("parseMarketplaceSource", () => {
  it("reads ours, the default, as a GitHub repository pinned to main", () => {
    expect(parse(DEFAULT_MARKETPLACE)).toEqual({
      forge: "github",
      host: "github.com",
      repo: "tyler-r-kendrick/OpenSesame",
      ref: "main",
      root: "",
    });
  });

  it.each([
    ["octo/types", "github", "github.com", "octo/types", null, ""],
    ["octo/types#v2", "github", "github.com", "octo/types", "v2", ""],
    [
      "https://github.com/octo/types.git",
      "github",
      "github.com",
      "octo/types",
      null,
      "",
    ],
    [
      "https://github.com/octo/types/tree/release/1.x/types",
      "github",
      "github.com",
      "octo/types",
      "release",
      "1.x/types",
    ],
    [
      "git@github.com:octo/types.git",
      "github",
      "github.com",
      "octo/types",
      null,
      "",
    ],
    [
      "https://gitlab.com/team/sub/types/-/tree/main/market",
      "gitlab",
      "gitlab.com",
      "team/sub/types",
      "main",
      "market",
    ],
    ["gitlab:team/types", "gitlab", "gitlab.com", "team/types", null, ""],
    ["codeberg:octo/types", "gitea", "codeberg.org", "octo/types", null, ""],
    [
      "https://codeberg.org/octo/types/src/branch/dev",
      "gitea",
      "codeberg.org",
      "octo/types",
      "dev",
      "",
    ],
    [
      "gitea+https://git.example.com:3000/octo/types",
      "gitea",
      "git.example.com:3000",
      "octo/types",
      null,
      "",
    ],
    [
      "forgejo+https://forge.example.org/octo/types#v1",
      "gitea",
      "forge.example.org",
      "octo/types",
      "v1",
      "",
    ],
    ["bitbucket:ws/types", "bitbucket", "bitbucket.org", "ws/types", null, ""],
    [
      "https://gitlab.internal.example/ops/types",
      "gitlab",
      "gitlab.internal.example",
      "ops/types",
      null,
      "",
    ],
  ])("reads %s", (input, forge, host, repo, ref, root) => {
    expect(parse(input)).toEqual({ forge, host, repo, ref, root });
  });

  it("reads any host that serves the index as a raw file", () => {
    const source = parse(
      `https://git.example.net/cgit/types/plain/${INDEX_PATH}`,
    );
    expect(source).toEqual({
      forge: "raw",
      base: "https://git.example.net/cgit/types/plain/",
    });
  });

  it.each([
    "",
    "octo",
    "octo/types/extra",
    "http://github.com/octo/types",
    "https://user:token@github.com/octo/types",
    "https://git.example.net/octo/types",
    "octo/../types",
    "octo/types#../main",
    "octo/types#",
    "ftp:octo/types",
    "unknown+https://git.example.net/octo/types",
    `https://git.example.net/${INDEX_PATH}?token=1`,
    "octo/ types",
  ])("refuses %j", (input) => {
    expect(parseMarketplaceSource(input)).toBeNull();
  });
});

describe("hosts and index links", () => {
  it("never reads a self-hosted GitHub or Bitbucket through the public site", () => {
    expect(
      parseMarketplaceSource("github+https://ghe.corp.example/acme/types"),
    ).toBeNull();
    expect(
      parseMarketplaceSource("bitbucket+https://bb.corp.example/ws/types"),
    ).toBeNull();
    expect(
      parseMarketplaceSource(
        `https://ghe.corp.example/acme/types/raw/main/${INDEX_PATH}`,
      ),
    ).toEqual({
      forge: "raw",
      base: "https://ghe.corp.example/acme/types/raw/main/",
    });
  });

  it("reads a forge's link to the index file as that repository", () => {
    expect(parse(`https://github.com/o/r/blob/main/${INDEX_PATH}`)).toEqual({
      forge: "github",
      host: "github.com",
      repo: "o/r",
      ref: "main",
      root: "",
    });
    expect(
      parse(`https://gitlab.com/g/r/-/blob/dev/sub/${INDEX_PATH}`),
    ).toEqual({
      forge: "gitlab",
      host: "gitlab.com",
      repo: "g/r",
      ref: "dev",
      root: "sub",
    });
  });

  it("round-trips a ref with a slash beside a directory, and HEAD as no pin", () => {
    const source = parse("https://github.com/o/r/tree/x/sub#release/1.0");
    expect(source).toMatchObject({ ref: "release/1.0", root: "sub" });
    expect(parse(sourceReference(source))).toEqual(source);
    const bitbucket = parse("https://bitbucket.org/ws/r/src/HEAD/sub");
    expect(bitbucket).toMatchObject({ ref: null, root: "sub" });
    expect(parse(sourceReference(bitbucket))).toEqual(bitbucket);
  });
});

describe("sourceReference", () => {
  it.each([
    DEFAULT_MARKETPLACE,
    "octo/types",
    "https://gitlab.com/team/sub/types/-/tree/main/market",
    "https://github.com/octo/types/tree/v1/types",
    "https://codeberg.org/octo/types/src/branch/dev/x",
    "https://bitbucket.org/ws/types/src/main/x",
    "gitea+https://git.example.com/octo/types#v1",
    `https://git.example.net/cgit/types/plain/${INDEX_PATH}`,
  ])("round-trips %s", (input) => {
    const source = parse(input);
    expect(parse(sourceReference(source))).toEqual(source);
  });

  it("gives equal spellings one canonical reference", () => {
    const a = sourceReference(parse("https://github.com/octo/types.git"));
    const b = sourceReference(parse("git@github.com:octo/types"));
    expect(a).toBe("github:octo/types");
    expect(b).toBe(a);
  });
});

describe("rawFileUrl", () => {
  it("reads GitHub through raw.githubusercontent.com at the pinned ref", () => {
    expect(rawFileUrl(parse(DEFAULT_MARKETPLACE), INDEX_PATH)).toBe(
      "https://raw.githubusercontent.com/tyler-r-kendrick/OpenSesame/main/.opensesame/marketplace.json",
    );
    expect(rawFileUrl(parse("octo/types"), "a.json")).toBe(
      "https://raw.githubusercontent.com/octo/types/HEAD/a.json",
    );
  });

  it("reads GitLab through its files API, groups and path encoded", () => {
    expect(
      rawFileUrl(
        parse("https://gitlab.com/team/sub/types/-/tree/main/market"),
        "t/a.json",
      ),
    ).toBe(
      "https://gitlab.com/api/v4/projects/team%2Fsub%2Ftypes/repository/files/market%2Ft%2Fa.json/raw?ref=main",
    );
  });

  it("reads Gitea and Forgejo through the raw API, default branch unless pinned", () => {
    expect(rawFileUrl(parse("codeberg:octo/types"), "a.json")).toBe(
      "https://codeberg.org/api/v1/repos/octo/types/raw/a.json",
    );
    expect(rawFileUrl(parse("codeberg:octo/types#v1"), "a.json")).toBe(
      "https://codeberg.org/api/v1/repos/octo/types/raw/a.json?ref=v1",
    );
  });

  it("reads Bitbucket through its src API at a resolved ref", () => {
    expect(rawFileUrl(parse("bitbucket:ws/types"), "a.json", "trunk")).toBe(
      "https://api.bitbucket.org/2.0/repositories/ws/types/src/trunk/a.json",
    );
  });

  it("keeps a raw source's files under its own base", () => {
    const source = parse(`https://git.example.net/r/${INDEX_PATH}`);
    expect(rawFileUrl(source, "types/a.json")).toBe(
      "https://git.example.net/r/types/a.json",
    );
  });
});

describe("sourceLabel", () => {
  it("names host, repository, root and pin", () => {
    expect(sourceLabel(parse(DEFAULT_MARKETPLACE))).toBe(
      "github.com/tyler-r-kendrick/OpenSesame@main",
    );
    expect(sourceLabel(parse(`https://git.example.net/r/${INDEX_PATH}`))).toBe(
      "git.example.net/r",
    );
  });
});
