import { describe, expect, it } from "vitest";
import { CsvParseError, parseCsv, parseCsvCells, pick } from "./csv.js";

describe("parseCsvCells", () => {
  it("reads plain rows", () => {
    expect(parseCsvCells("a,b\n1,2")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("keeps commas inside quotes", () => {
    expect(parseCsvCells('a,b\n"one, two",3')).toEqual([
      ["a", "b"],
      ["one, two", "3"],
    ]);
  });

  it("keeps newlines inside quotes", () => {
    const rows = parseCsvCells('name,note\nSite,"line one\nline two"');
    expect(rows[1]).toEqual(["Site", "line one\nline two"]);
  });

  it("unescapes doubled quotes", () => {
    // A password of  He said "hi"  is a real thing people have.
    const rows = parseCsvCells('password\n"He said ""hi"""');
    expect(rows[1]).toEqual(['He said "hi"']);
  });

  it("handles CRLF line endings", () => {
    expect(parseCsvCells("a,b\r\n1,2\r\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("strips a byte order mark from the first header", () => {
    const rows = parseCsvCells("\uFEFFname,url\nSite,https://x.test");
    expect(rows[0]?.[0]).toBe("name");
  });

  it("keeps empty trailing cells", () => {
    expect(parseCsvCells("a,b,c\n1,,")).toEqual([
      ["a", "b", "c"],
      ["1", "", ""],
    ]);
  });

  it("does not invent a row from a trailing newline", () => {
    expect(parseCsvCells("a\n1\n")).toHaveLength(2);
  });

  it("treats a quote inside an unquoted cell as literal", () => {
    expect(parseCsvCells('a\n12"34')).toEqual([["a"], ['12"34']]);
  });

  it("rejects a file that ends mid-quote", () => {
    expect(() => parseCsvCells('a\n"unterminated')).toThrow(CsvParseError);
  });
});

describe("parseCsv", () => {
  it("lowercases headers and keys rows by them", () => {
    const { headers, rows } = parseCsv("Name,URL\nSite,https://x.test");
    expect(headers).toEqual(["name", "url"]);
    expect(rows[0]).toEqual({ name: "Site", url: "https://x.test" });
  });

  it("skips rows that are entirely blank", () => {
    expect(parseCsv("a,b\n1,2\n,\n3,4").rows).toHaveLength(2);
  });

  it("fills missing trailing columns rather than leaving them undefined", () => {
    // Chrome omits the note column entirely on some rows.
    const { rows } = parseCsv("name,url,note\nSite,https://x.test");
    expect(rows[0]?.note).toBe("");
  });

  it("rejects an empty file", () => {
    expect(() => parseCsv("")).toThrow(CsvParseError);
  });
});

describe("pick", () => {
  it("returns the first populated column", () => {
    const row = { username: "", email: "a@b.test" };
    expect(pick(row, "username", "email")).toBe("a@b.test");
  });

  it("returns empty when nothing matches", () => {
    expect(pick({ a: "1" }, "b", "c")).toBe("");
  });
});
