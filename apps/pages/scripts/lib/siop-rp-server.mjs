/**
 * Real servers for the cross-origin relying-party journey (ADR 0161): the
 * example relying party (`examples/siop-rp`) as its own process, and a tiny
 * static server for the built `dist/`, which is where that process reads the
 * deployment's `siop-metadata.json` from (the production origin is mocked in
 * the browser, so a Node process cannot reach it by name).
 *
 * Both are real HTTP on loopback. Nothing here mocks the verifier: the RP
 * verifies every token with `@opensesame/siop-v2` inside its own process.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const rpDirectory = path.join(repoRoot, "examples/siop-rp");

const TYPES = {
  ".html": "text/html",
  ".json": "application/json",
};

/** A loopback port nothing is listening on, found by asking the kernel. */
export function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/** Serve two files of `dist/` and nothing else, over loopback http. */
export async function serveDist(dist) {
  const server = http.createServer((request, response) => {
    const name = request.url?.split("?")[0]?.replace(/^\//, "") ?? "";
    const file = path.join(dist, name);
    const served =
      (name === "siop-metadata.json" || name === "index.html") &&
      fs.existsSync(file);
    if (!served) {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("not found");
      return;
    }
    response.writeHead(200, {
      "content-type": TYPES[path.extname(file)] ?? "text/plain",
    });
    response.end(fs.readFileSync(file));
  });
  await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((done) => server.close(() => done())),
  };
}

/**
 * Start the example relying party as `node --import tsx src/server.ts`, the
 * way its README says to. `ready` settles when it prints that it is
 * listening; `exited` settles with its exit code, which is how a refusal at
 * startup (discovery that does not check out) shows.
 */
export function startRelyingParty(env) {
  const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
    cwd: rpDirectory,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  const exited = new Promise((resolve) => {
    child.on("exit", (code) => resolve(code));
  });
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      clearInterval(poll);
      reject(new Error(`relying party did not start:\n${output}`));
    }, 30_000);
    const poll = setInterval(() => {
      if (!output.includes("listening")) return;
      clearTimeout(timer);
      clearInterval(poll);
      resolve(undefined);
    }, 50);
    exited.then((code) => {
      clearTimeout(timer);
      clearInterval(poll);
      reject(new Error(`relying party exited ${code}:\n${output}`));
    });
  });
  // A caller that only wants the exit code never awaits `ready`.
  ready.catch(() => undefined);
  return {
    ready,
    exited,
    output: () => output,
    stop: () => {
      child.kill("SIGTERM");
      return exited;
    },
  };
}
