import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  printConnections,
  printFailure,
  printResult,
  printable,
} from "./session-output.js";

let out = "";
let err = "";

beforeEach(() => {
  out = "";
  err = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    out += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    err += String(chunk);
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const human = { json: false };
const json = { json: true };
const ESC = String.fromCharCode(27);

describe("printable", () => {
  it("replaces what a terminal would act on, and nothing else", () => {
    expect(printable(`ok ${ESC}[31mred${ESC}[0m‮\u0007 é 日本`)).toBe(
      "ok ?[31mred?[0m?? é 日本",
    );
  });
});

describe("printConnections", () => {
  const one = {
    id: "c-github",
    label: "GitHub",
    provider: "github",
    operations: ["provider.read"],
  };
  const two = {
    id: "c-linear-long",
    label: "Linear",
    provider: "linear",
    operations: ["provider.read", "provider.issues.read"],
  };

  it("lines the rows up in columns on stdout", () => {
    printConnections(human, [one, two], 0);
    expect(out).toBe(
      "c-github       GitHub  github  provider.read\nc-linear-long  Linear  linear  provider.read, provider.issues.read\n",
    );
    expect(err).toBe("");
  });

  it("says when the grant lapses, on stderr, and keeps stdout to the rows", () => {
    printConnections(human, [one], Date.parse("2026-10-12T10:00:00Z"));
    expect(err).toBe("The host's grant lapses at 2026-10-12T10:00:00.000Z.\n");
    expect(out).toContain("c-github");
  });

  it("prints nothing on stdout, and says so, when nothing was granted", () => {
    printConnections(human, [], 0);
    expect(out).toBe("");
    expect(err).toBe("The host granted no connections.\n");
  });

  it("is one document with --json, whatever was granted", () => {
    printConnections(json, [], 0);
    expect(JSON.parse(out)).toEqual({
      ok: true,
      action: "list",
      connections: [],
    });
  });

  it("strips terminal controls from what the host's tab reported", () => {
    printConnections(human, [{ ...one, label: `Git${ESC}[2JHub` }], 0);
    expect(out).not.toContain(ESC);
    expect(out).toContain("Git?[2JHub");
  });
});

describe("printResult", () => {
  const call = { connection: "c-github", operation: "provider.read" };

  it("prints the label, then a line per item, address last", () => {
    printResult(human, call, {
      label: "[Repos]",
      items: [
        { id: "a/b", label: "b", url: "https://x.test/a/b" },
        { id: "a/long-name", label: "long" },
      ],
      truncated: false,
    });
    // A label that starts like JSON is a label, not a request for JSON.
    expect(out).toBe(
      "[Repos]\na/b          b  https://x.test/a/b\na/long-name  long\n",
    );
    expect(err).toBe("");
  });

  it("notes an empty or a cut-short answer on stderr", () => {
    printResult(human, call, { label: "None", items: [], truncated: true });
    expect(out).toBe("None\n");
    expect(err).toContain("cut this answer short");
    expect(err).toContain("returned no items");
  });

  it("strips terminal controls from an item's address", () => {
    printResult(human, call, {
      label: "L",
      items: [{ id: "i", label: "n", url: `https://x.test/${ESC}]0;pwn` }],
      truncated: false,
    });
    expect(out).not.toContain(ESC);
  });

  it("is one document with --json, carrying the text as the host sent it", () => {
    printResult(json, call, {
      label: "Repos",
      items: [{ id: "a", label: "A" }],
      truncated: true,
    });
    expect(JSON.parse(out)).toEqual({
      ok: true,
      action: "invoke",
      connection: "c-github",
      operation: "provider.read",
      label: "Repos",
      items: [{ id: "a", label: "A" }],
      truncated: true,
    });
  });
});

describe("printFailure", () => {
  const failure = { code: "access_denied", message: "The host said no." };

  it("is a line on stderr and nothing on stdout", () => {
    printFailure(human, failure);
    expect(err).toBe("The host said no.\n");
    expect(out).toBe("");
  });

  it("is also one document on stdout with --json", () => {
    printFailure(json, failure);
    expect(err).toBe("The host said no.\n");
    expect(JSON.parse(out)).toEqual({
      ok: false,
      error: "access_denied",
      message: "The host said no.",
    });
  });
});
