import { afterEach, describe, expect, it, vi } from "vitest";
import { helpText, parseArgs } from "./parse.js";
import { DEFAULT_SESSION_TIMEOUT_SECONDS } from "./session-parse.js";

// The parser only reads the shape of a command; the link is read when it is used.
const LINK = "https://app.example.test/#live=v1.o.OWNER.SECRET";
const CODE = "BCDF-GHJK";

afterEach(() => {
  vi.unstubAllEnvs();
});

function refusal(argv: string[]): string {
  try {
    parseArgs(argv);
  } catch (error) {
    if (error instanceof Error) return error.message;
  }
  throw new Error("expected a refusal");
}

describe("parseArgs — session list", () => {
  it("takes the link first and fills in the defaults", () => {
    expect(parseArgs(["session", LINK, "list"])).toEqual({
      name: "session",
      action: "list",
      link: LINK,
      code: null,
      deviceName: null,
      want: [],
      timeoutSeconds: DEFAULT_SESSION_TIMEOUT_SECONDS,
      flags: { json: false },
    });
    expect(DEFAULT_SESSION_TIMEOUT_SECONDS).toBe(900);
  });

  it("reads every option, wherever it stands, and --json", () => {
    const parsed = parseArgs([
      "session",
      "--code",
      CODE,
      LINK,
      "--connection",
      "c-github",
      "list",
      "--name",
      "build box",
      "--connection",
      "c-linear",
      "--connection",
      "c-github",
      "--timeout",
      "30",
      "--json",
    ]);
    expect(parsed).toMatchObject({
      action: "list",
      link: LINK,
      code: CODE,
      deviceName: "build box",
      want: ["c-github", "c-linear"],
      timeoutSeconds: 30,
      flags: { json: true },
    });
  });

  it("allows a fraction of a second for a timeout", () => {
    expect(
      parseArgs(["session", LINK, "list", "--timeout", "0.5"]),
    ).toMatchObject({ timeoutSeconds: 0.5 });
  });

  it("takes the link and the code from the environment, keeping them out of argv", () => {
    vi.stubEnv("OPENSESAME_LIVE_LINK", LINK);
    vi.stubEnv("OPENSESAME_LIVE_CODE", CODE);
    expect(parseArgs(["session", "list"])).toMatchObject({
      action: "list",
      link: LINK,
      code: CODE,
    });
  });

  it("prefers what is typed to what the environment holds", () => {
    vi.stubEnv("OPENSESAME_LIVE_LINK", "https://env.example.test/#live=v1.x");
    vi.stubEnv("OPENSESAME_LIVE_CODE", "WWWW-XXXX");
    expect(parseArgs(["session", LINK, "list", "--code", CODE])).toMatchObject({
      link: LINK,
      code: CODE,
    });
  });

  it("treats an empty variable as unset", () => {
    vi.stubEnv("OPENSESAME_LIVE_LINK", "  ");
    vi.stubEnv("OPENSESAME_LIVE_CODE", "");
    expect(() => parseArgs(["session", "list"])).toThrow(
      /OPENSESAME_LIVE_LINK/,
    );
    expect(parseArgs(["session", LINK, "list"])).toMatchObject({ code: null });
  });
});

describe("parseArgs — session invoke", () => {
  it("names a connection and an operation, and suggests the connection", () => {
    expect(
      parseArgs([
        "session",
        LINK,
        "invoke",
        "c-github",
        "provider.repositories.read",
      ]),
    ).toMatchObject({
      action: "invoke",
      connection: "c-github",
      operation: "provider.repositories.read",
      input: {},
      want: ["c-github"],
    });
  });

  it("collects --input pairs, keeping everything after the first =", () => {
    const parsed = parseArgs([
      "session",
      LINK,
      "invoke",
      "c-github",
      "provider.read",
      "--input",
      "org=acme",
      "--input",
      "query=a=b",
      "--input",
      "empty=",
      "--connection",
      "c-linear",
    ]);
    expect(parsed).toMatchObject({
      input: { org: "acme", query: "a=b", empty: "" },
      want: ["c-linear", "c-github"],
    });
  });

  it("reads the link from the environment here too", () => {
    vi.stubEnv("OPENSESAME_LIVE_LINK", LINK);
    expect(
      parseArgs(["session", "invoke", "c-github", "provider.read"]),
    ).toMatchObject({ link: LINK, connection: "c-github" });
  });
});

describe("parseArgs — session refusals", () => {
  it.each([
    [["session"], /needs the live link/],
    [["session", LINK], /needs list or invoke/],
    [["session", LINK, "frobnicate"], /needs list or invoke/],
    [["session", LINK, "list", "extra"], /list takes no argument/],
    [["session", LINK, "invoke"], /needs <connection> and <operation>/],
    [
      ["session", LINK, "invoke", "c-github"],
      /needs <connection> and <operation>/,
    ],
    [
      ["session", LINK, "invoke", "c-github", "provider.read", "more"],
      /no more arguments/,
    ],
    [["session", LINK, "invoke", "bad id", "provider.read"], /connection id/],
    [["session", LINK, "invoke", "c-github", "Provider.Read"], /operation/],
    [["session", LINK, "list", "--input", "a=b"], /list takes no --input/],
    [["session", LINK, "list", "--frobnicate"], /does not take --frobnicate/],
    [["session", LINK, "list", "--code"], /--code needs a value/],
    [["session", LINK, "list", "--code", "--name"], /--code needs a value/],
    [["session", LINK, "list", "--code", CODE, "--code", CODE], /given twice/],
    [["session", LINK, "list", "--name", "a", "--name", "b"], /given twice/],
  ])("%j is refused", (argv, message) => {
    expect(refusal(argv)).toMatch(message);
  });

  it.each(["0", "-5", "abc", "", "Infinity", "100000"])(
    "refuses --timeout %j",
    (seconds) => {
      expect(refusal(["session", LINK, "list", "--timeout", seconds])).toMatch(
        /--timeout/,
      );
    },
  );

  it.each([
    ["nopair"],
    ["=value"],
    ["1bad=x"],
    ["has space=x"],
    [`big=${"x".repeat(2049)}`],
  ])("refuses --input %j", (pair) => {
    expect(() =>
      parseArgs([
        "session",
        LINK,
        "invoke",
        "c",
        "provider.read",
        "--input",
        pair,
      ]),
    ).toThrow(/--input/);
  });

  it("refuses a repeated or a ninth --input", () => {
    const args = ["session", LINK, "invoke", "c", "provider.read"];
    expect(refusal([...args, "--input", "a=1", "--input", "a=2"])).toMatch(
      /repeats a key/,
    );
    const nine = Array.from({ length: 9 }, (_, at) => ["--input", `k${at}=v`]);
    expect(refusal([...args, ...nine.flat()])).toMatch(/up to 8 pairs/);
  });

  it("refuses a ninth connection to suggest", () => {
    const nine = Array.from({ length: 9 }, (_, at) => [
      "--connection",
      `c-${at}`,
    ]);
    expect(refusal(["session", LINK, "list", ...nine.flat()])).toMatch(
      /at most 8 connections/,
    );
  });

  it("never repeats the link, the code or an unknown option's value", () => {
    const messages = [
      refusal(["session", LINK, "list", "extra"]),
      refusal(["session", LINK, "frobnicate", "--code", CODE]),
      refusal(["session", LINK, "list", `--code=${CODE}`]),
      refusal(["session", LINK, "list", "--timeout", CODE]),
      refusal(["session", LINK, "invoke", `bad ${CODE}`, "provider.read"]),
      refusal(["session", "list", LINK]),
    ];
    for (const message of messages) {
      expect(message).not.toContain(LINK);
      expect(message).not.toContain(CODE);
      expect(message).not.toContain("OWNER");
    }
  });
});

describe("helpText — session", () => {
  it("describes both verbs and where the bearers should come from", () => {
    const text = helpText();
    expect(text).toContain("session [<link>] list");
    expect(text).toContain("session [<link>] invoke <connection> <operation>");
    expect(text).toContain("OPENSESAME_LIVE_LINK");
    expect(text).toContain("OPENSESAME_LIVE_CODE");
  });
});
