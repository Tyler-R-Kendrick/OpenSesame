import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { loadSession, saveSession } from "./identity-session.js";

let directory = "";
const session = {
  issuer: "https://customer-a.example",
  clientId: "cli-a",
  accessToken: "secret-access-a",
  refreshToken: "secret-refresh-a",
};
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "cli-envelope-"));
  vi.stubEnv("OPENSESAME_STATE_DIR", directory);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});
it("uses fresh data keys and rejects issuer/client ciphertext transplants", async () => {
  const path = join(directory, "identity-session.json");
  await saveSession(session);
  const first = await readFile(path, "utf8");
  expect(first).not.toContain(session.accessToken);
  expect(first).not.toContain(session.refreshToken);
  expect(await loadSession()).toEqual(session);
  await saveSession(session);
  expect(await readFile(path, "utf8")).not.toEqual(first);
  const envelope: {
    version: number;
    issuer: string;
    clientId: string;
    sealed: string;
  } = JSON.parse(first);
  for (const changed of [
    { ...envelope, issuer: "https://customer-b.example" },
    { ...envelope, clientId: "cli-b" },
    { ...envelope, sealed: `${envelope.sealed.slice(0, -4)}AAAA` },
  ]) {
    await writeFile(path, JSON.stringify(changed), { mode: 0o600 });
    expect(await loadSession()).toBeNull();
  }
  expect(
    (await stat(join(directory, "identity-session.key"))).mode & 0o777,
  ).toBe(0o600);
});
it("migrates legacy plaintext on successful private-file load", async () => {
  const path = join(directory, "identity-session.json");
  await writeFile(path, JSON.stringify(session), { mode: 0o600 });
  expect(await loadSession()).toEqual(session);
  expect(await readFile(path, "utf8")).not.toContain(session.accessToken);
  expect(await loadSession()).toEqual(session);
});
it("rejects ciphertext copied into a different local root", async () => {
  await saveSession(session);
  const sealed = await readFile(
    join(directory, "identity-session.json"),
    "utf8",
  );
  const second = join(directory, "other");
  vi.stubEnv("OPENSESAME_STATE_DIR", second);
  await saveSession({ ...session, accessToken: "other-root" });
  await writeFile(join(second, "identity-session.json"), sealed, {
    mode: 0o600,
  });
  expect(await loadSession()).toBeNull();
  await chmod(join(second, "identity-session.key"), 0o644);
  expect(await loadSession()).toBeNull();
});

it("does not generate a replacement root when opening an orphan envelope", async () => {
  await saveSession(session);
  const path = join(directory, "identity-session.key");
  await rm(path);
  expect(await loadSession()).toBeNull();
  await expect(stat(path)).rejects.toThrow();
});
