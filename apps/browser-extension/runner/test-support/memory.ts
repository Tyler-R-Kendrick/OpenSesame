/** An in-memory `chrome.storage.local`, and the device key it is sealed under. */
import { useClientAtRestKeys } from "@opensesame/browser-at-rest";
import type { RawStore } from "../store";

export class MemoryStore implements RawStore {
  readonly rows = new Map<string, string>();
  async get(key: string) {
    return this.rows.get(key);
  }
  async set(key: string, value: string) {
    this.rows.set(key, value);
  }
  async remove(key: string) {
    this.rows.delete(key);
  }
  async keys() {
    return [...this.rows.keys()];
  }
}

/** Mint a real non-extractable AES-GCM key for this test process. */
export function useTestDeviceKey(): void {
  useClientAtRestKeys(() =>
    crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
      "encrypt",
      "decrypt",
    ]),
  );
}
