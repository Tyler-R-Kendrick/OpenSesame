import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findBrowserGlobals, mustBePortable } from "./app-core-portability.mjs";

const SOURCES = {
  "src/lib/storage.ts": [
    'export const read = () => localStorage.getItem("k");',
    "export const viaGlobal = () => globalThis.sessionStorage;",
  ].join("\n"),
  "src/lib/contract.ts": [
    "export async function digest(bytes: Uint8Array) {",
    '  const url = new URL("https://example.test");',
    '  return [url, await crypto.subtle.digest("SHA-256", bytes), setTimeout];',
    "}",
  ].join("\n"),
  "src/lib/types-only.ts": [
    "export type Credential = PublicKeyCredential;",
    "export function id(credential: PublicKeyCredential): string {",
    "  return credential.id;",
    "}",
  ].join("\n"),
  "src/lib/instance.ts": [
    "export const isCredential = (value: object) =>",
    "  value instanceof PublicKeyCredential;",
  ].join("\n"),
  "src/lib/shadowed.ts": [
    "export function start(Worker: new (url: URL) => object) {",
    '  return new Worker(new URL("./x.worker.ts", import.meta.url));',
    "}",
  ].join("\n"),
};

let dir = "";
let found = [];

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "app-core-portability-"));
  mkdirSync(join(dir, "src/lib"), { recursive: true });
  for (const [path, source] of Object.entries(SOURCES))
    writeFileSync(join(dir, path), source);
  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        lib: ["ES2022", "DOM"],
        module: "ESNext",
        moduleResolution: "Bundler",
        strict: true,
        noEmit: true,
        types: [],
      },
      include: ["src"],
    }),
  );
  found = findBrowserGlobals(join(dir, "tsconfig.json"), () => true).map(
    ({ file, name }) => `${file.slice(dir.length + 1)} ${name}`,
  );
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("findBrowserGlobals", () => {
  it("reports browser-only globals, bare or through globalThis", () => {
    expect(found).toContain("src/lib/storage.ts localStorage");
    expect(found).toContain("src/lib/storage.ts sessionStorage");
  });

  it("reports a browser interface used as a value", () => {
    expect(found).toContain("src/lib/instance.ts PublicKeyCredential");
  });

  it("allows the runtime contract, type positions and shadowed names", () => {
    const clean = ["contract.ts", "types-only.ts", "shadowed.ts"];
    expect(
      found.filter((row) => clean.some((file) => row.includes(file))),
    ).toEqual([]);
  });
});

describe("mustBePortable", () => {
  it("exempts the browser host, worker entries and tests", () => {
    expect(mustBePortable("src/lib/kv.ts")).toBe(true);
    expect(mustBePortable("src/node/host.ts")).toBe(true);
    expect(mustBePortable("src/browser/host.ts")).toBe(false);
    expect(mustBePortable("src/lib/sops/sops.worker.ts")).toBe(false);
    expect(mustBePortable("src/lib/kv.test.ts")).toBe(false);
    expect(mustBePortable("src/test-host.ts")).toBe(false);
  });
});
