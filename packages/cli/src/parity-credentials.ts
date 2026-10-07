import { spawn } from "node:child_process";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  atRestBinding,
  openAtRest,
  sealAtRest,
} from "@opensesame/app-core/lib/at-rest/cipher.js";
import type {
  CredentialStore,
  ServiceSettings,
} from "@opensesame/app-core/lib/password-agent/auth.js";
import { loadAtRestKeyFile } from "@opensesame/app-core/node/at-rest-key-file.js";
import { defaultStateDir } from "@opensesame/app-core/node/host.js";
import { z } from "zod";
import { resolveCredentialHelper, writePrivateFile } from "./parity-node.js";

import { guardedEffect, parityAuthority } from "./parity-authority.js";

function osCredential(operation: string, token?: string): Promise<string> {
  const check = parityAuthority();
  const windows = process.platform === "win32";
  const asset = fileURLToPath(
    new URL(
      windows
        ? "./parity-assets/credential.win.ps1"
        : "./parity-assets/keychain.jxa.js",
      import.meta.url,
    ),
  );
  const args = windows
    ? [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        asset,
      ]
    : ["-l", "JavaScript", asset];
  return new Promise((resolve, reject) => {
    const child = spawn(
      resolveCredentialHelper(windows ? "powershell" : "osascript"),
      [...args, operation, "dev.opensesame.password-agent", "service-account"],
      { stdio: ["pipe", "pipe", "ignore"], shell: false },
    );
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
      if (output.length > 16_777_216) child.kill();
    });
    child.on("error", () =>
      reject(new Error("Credential storage failed; details suppressed.")),
    );
    child.on("close", (code) => {
      try {
        check();
      } catch (error) {
        reject(error);
        return;
      }
      if (code === 0) resolve(output.replace(/\r?\n$/, ""));
      else reject(new Error("Credential storage failed; details suppressed."));
    });
    child.stdin.on("error", () => {});
    child.stdin.end(token);
  });
}
/** OS stores on macOS/Windows; Linux uses the existing owner-only at-rest key. */
export function createCredentialStore(
  stateDir = defaultStateDir(),
): CredentialStore {
  const os = process.platform === "darwin" || process.platform === "win32";
  const { directory, path, key, binding, exists, load, save } =
    fileCredentials(stateDir);
  const store: CredentialStore = {
    storage: os
      ? process.platform === "darwin"
        ? "macos-keychain"
        : "windows-dpapi"
      : "encrypted-file-owner-key",
    hasToken: async () => {
      if (!os) return exists("token");
      const result = await osCredential("exists");
      if (result !== "found" && result !== "missing")
        throw new Error("Credential storage state is unverified.");
      return result === "found";
    },
    loadToken: () => (os ? osCredential("get") : load("token")),
    async saveToken(token) {
      const check = parityAuthority();
      if (os) {
        await osCredential("add", token);
        return;
      }
      await mkdir(directory, { recursive: true, mode: 0o700 });
      check();
      await writeFile(
        path("token"),
        sealAtRest(key(), binding("token"), token),
        { flag: "wx", mode: 0o600 },
      );
    },
    async removeToken() {
      if (os) await osCredential("remove");
      else await rm(path("token"), { force: true });
    },
    async loadSettings() {
      const check = parityAuthority();
      const present = await exists("settings");
      check();
      if (!present) return undefined;
      const plaintext = await load("settings");
      check();
      const value = z
        .object({
          name: z.string(),
          vaults: z.array(z.object({ id: z.string(), name: z.string() })),
          tokenRef: z.string().optional(),
        })
        .parse(JSON.parse(plaintext));
      const settings: ServiceSettings = {
        name: value.name,
        vaults: value.vaults,
      };
      if (value.tokenRef !== undefined) settings.tokenRef = value.tokenRef;
      return settings;
    },
    saveSettings: (settings) => save("settings", JSON.stringify(settings)),
    removeSettings: () => rm(path("settings"), { force: true }),
  };
  return {
    storage: store.storage,
    hasToken: guardedEffect(store.hasToken),
    loadToken: guardedEffect(store.loadToken),
    saveToken: guardedEffect(store.saveToken),
    removeToken: guardedEffect(store.removeToken),
    loadSettings: guardedEffect(store.loadSettings),
    saveSettings: guardedEffect(store.saveSettings),
    removeSettings: guardedEffect(store.removeSettings),
  };
}

function fileCredentials(stateDir: string) {
  const directory = join(stateDir, "password-agent");
  const path = (name: string) => join(directory, name);
  const key = () => {
    parityAuthority();
    return loadAtRestKeyFile(join(stateDir, "at-rest.key"));
  };
  const binding = (name: string) => atRestBinding("password-agent", name);
  async function exists(name: string) {
    const check = parityAuthority();
    try {
      await access(path(name));
      check();
      return true;
    } catch (error) {
      check();
      if (z.object({ code: z.literal("ENOENT") }).safeParse(error).success)
        return false;
      throw new Error("Credential storage is unavailable.");
    }
  }
  async function load(name: string) {
    const check = parityAuthority();
    const ciphertext = await readFile(path(name), "utf8");
    check();
    const value = openAtRest(key(), binding(name), ciphertext);
    if (value === null)
      throw new Error("Saved credential storage could not be opened.");
    return value;
  }
  async function save(name: string, value: string) {
    const check = parityAuthority();
    await mkdir(directory, { recursive: true, mode: 0o700 });
    check();
    await writePrivateFile(path(name), sealAtRest(key(), binding(name), value));
  }
  return { directory, path, key, binding, exists, load, save };
}
