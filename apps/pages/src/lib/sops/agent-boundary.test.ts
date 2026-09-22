/** @vitest-environment node */
/**
 * SB-065: no agent or support surface can reach SOPS plaintext, an
 * identity, a data key, or a usable decryption handle.
 *
 * The engine is reachable only from the human sheets. These tests read the
 * shipped sources rather than trusting a convention: a new WebMCP tool or
 * a support-context field that touched the engine would fail here.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WEBMCP_TOOLS } from "../../webmcp/tools.js";
import { SopsEngine } from "./engine.js";

const pagesSrc = join(__dirname, "..", "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.tsx?$/u.test(name) && !/\.test\.tsx?$/u.test(name))
      out.push(path);
  }
  return out;
}

/** Every module that reaches the SOPS engine, worker, or key material. */
const SOPS_IMPORT =
  /from "[^"]*lib\/sops\/(engine|session|workflow|runner|worker-client|sops\.worker|vault-secrets|keys\/age)\.js"/u;

describe("the SOPS engine is not reachable from an agent or support surface", () => {
  const modules = walk(pagesSrc).map((path) => ({
    path,
    source: readFileSync(path, "utf8"),
  }));

  it("no WebMCP tool names a SOPS, decrypt, identity, or data-key operation", () => {
    for (const tool of WEBMCP_TOOLS) {
      expect(tool.name, tool.name).not.toMatch(
        /sops|decrypt|identity_key|data_key|age_/iu,
      );
      expect(JSON.stringify(tool.inputSchema ?? {}), tool.name).not.toMatch(
        /sops|age identity/iu,
      );
    }
  });

  it("no webmcp, support-agent, tutorial, or analytics module imports the engine", () => {
    const forbidden = modules.filter(
      (module) =>
        /\/(webmcp|tutorial)\//u.test(module.path.replaceAll("\\", "/")) ||
        /support|telemetry|analytics|observab/iu.test(module.path),
    );
    expect(forbidden.length).toBeGreaterThan(5);
    for (const module of forbidden) {
      expect(SOPS_IMPORT.test(module.source), module.path).toBe(false);
    }
  });

  it("only the settings sheets and the session bind the engine", () => {
    const importers = modules
      .filter((module) => SOPS_IMPORT.test(module.source))
      .map((module) =>
        module.path
          .replaceAll("\\", "/")
          .slice(pagesSrc.replaceAll("\\", "/").length + 1),
      );
    for (const importer of importers) {
      expect(importer, importer).toMatch(
        /^(lib\/sops\/|sections\/settings\/(sops\/|FormatsInteroperabilityPanel))/u,
      );
    }
  });

  it("the engine exposes no getSecret, no raw key, and no root unwrap", () => {
    const surface = Object.getOwnPropertyNames(SopsEngine.prototype);
    expect(surface.sort()).toEqual(
      [
        "constructor",
        "dispose",
        "disposeAll",
        "encryptNew",
        "inspect",
        "open",
        "plaintext",
        "rotate",
        "saveEdited",
      ].sort(),
    );
    const source = readFileSync(join(__dirname, "engine.ts"), "utf8");
    expect(source).not.toMatch(/getSecret|revealKey|exportKey|unwrapRoot/u);
  });

  it("the worker answers a fixed set of operations and no generic verb", () => {
    const protocol = readFileSync(join(__dirname, "protocol.ts"), "utf8");
    const kinds =
      /const KINDS = new Set\(\[([^\]]*)\]\)/u.exec(protocol)?.[1] ?? "";
    expect(kinds).toContain("inspect");
    expect(kinds).not.toMatch(/eval|fetch|import|exec|read|write/u);
    const worker = readFileSync(join(__dirname, "sops.worker.ts"), "utf8");
    expect(worker).not.toMatch(/\bfetch\(|importScripts|eval\(|new Function/u);
  });
});
