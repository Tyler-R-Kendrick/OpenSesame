/** Actual ciphertext transport only: these bytes do not grant owner authority. */
import { host } from "../../host.js";
import { vfsSeams } from "../vfs-seams-state.js";

export type AuthenticationCiphertext = Readonly<{
  tomb: string;
  header: string | null;
  body: string | null;
}>;

function unavailable(): never {
  throw new Error(
    "Fresh ciphertext reads are unavailable for this vault store.",
  );
}

/** A fixed crypto verifier must independently authenticate wrap, body, gates and context. */
export function captureAuthenticationStorage(
  tomb: string,
  original: () => void,
) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(tomb))
    throw new Error("Invalid authentication tomb.");
  const installedHost = host();
  const installed = {
    read: vfsSeams.readRaw,
    write: vfsSeams.writeRaw,
    refresh: vfsSeams.refreshRaw,
    open: vfsSeams.openBody,
  };
  const check = () => {
    original();
    if (
      host() !== installedHost ||
      vfsSeams.readRaw !== installed.read ||
      vfsSeams.writeRaw !== installed.write ||
      vfsSeams.refreshRaw !== installed.refresh ||
      vfsSeams.openBody !== installed.open
    )
      throw new Error("The original encrypted vault storage context changed.");
  };
  const refresh = async () => {
    check();
    if (!installed.read || !installed.write || !installed.refresh)
      unavailable();
    await installed.refresh(`tomb/${tomb}/header`, 1024 * 1024, check);
    check();
    await installed.refresh(`tomb/${tomb}/body`, 256 * 1024 * 1024, check);
    check();
  };
  const snapshot = (): AuthenticationCiphertext => {
    check();
    if (!installed.read) unavailable();
    const bytes = Object.freeze({
      tomb,
      header: installed.read(`tomb/${tomb}/header`),
      body: installed.read(`tomb/${tomb}/body`),
    });
    check();
    return bytes;
  };
  return Object.freeze({
    check,
    async read(): Promise<AuthenticationCiphertext> {
      await refresh();
      return snapshot();
    },
    async revalidate(expected: AuthenticationCiphertext): Promise<void> {
      await refresh();
      const current = snapshot();
      if (
        current.tomb !== expected.tomb ||
        current.header !== expected.header ||
        current.body !== expected.body
      )
        throw new Error("Vault ciphertext changed during authentication.");
      check();
    },
  });
}
