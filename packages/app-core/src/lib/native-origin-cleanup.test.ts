import { expect, it } from "vitest";
import {
  registerNativeProviderCleanup,
  retryNativeConnectorCleanup,
} from "./native-connector-lifecycle.js";
import { loadNativeConnectorRecord } from "./native-connector-store.js";
import { readNativeOriginPrivateKey } from "./native-origin-configuration.js";
import { originFixture } from "./native-origin.test-support.js";

it("preserves the active key on a zero-recovery retry", async () => {
  const f = await originFixture();
  try {
    const saved = await f.driver.configure(f.input);
    const release = registerNativeProviderCleanup("origin", f.driver.cleanup);
    try {
      await retryNativeConnectorCleanup(saved.connectionId, f.owner.transport);
    } finally {
      release();
    }
    expect(readNativeOriginPrivateKey(saved.connectionId, f.owner)).toBe(
      f.privateKey,
    );
    expect(
      loadNativeConnectorRecord(saved.connectionId)?.privateState.recovery,
    ).toEqual([]);
  } finally {
    await f.close();
  }
});
