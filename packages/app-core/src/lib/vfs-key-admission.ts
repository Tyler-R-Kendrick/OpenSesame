/** The storage boundary checks key, synthetic principal, and protected root generation. */
import {
  admitSyntheticTombAuthority,
  assertTombRealmAuthority,
  pinKeyAuthority,
  recordKeyAdmission,
} from "./vfs-authority.js";
import { VfsError } from "./vfs-errors.js";
import {
  assertRootGeneration,
  recordRootGeneration,
} from "./vfs-root-admission.js";
export function makeVfsKeyAdmission(
  keys: Map<string, CryptoKey>,
  readHeader: (tomb: string) => string | null,
) {
  const require = (tomb: string) => {
    const key = keys.get(tomb);
    if (!key)
      throw new VfsError(
        "locked",
        `Tomb "${tomb}" is locked — unlock its vault before reading or writing sealed files.`,
      );
    assertTombRealmAuthority(tomb, key);
    assertRootGeneration(tomb, key, readHeader(tomb));
    return key;
  };
  return {
    require,
    install(tomb: string, key: CryptoKey, synthetic: boolean) {
      if (synthetic) admitSyntheticTombAuthority(tomb, key);
      recordKeyAdmission(key);
      recordRootGeneration(tomb, key, readHeader(tomb));
      keys.set(tomb, key);
    },
    pin(tomb: string, expectedKey?: CryptoKey) {
      const key = require(tomb);
      if (expectedKey && expectedKey !== key)
        throw new VfsError(
          "locked",
          "The original tomb key is no longer admitted.",
        );
      return pinKeyAuthority(() => {
        assertRootGeneration(tomb, key, readHeader(tomb));
        return keys.get(tomb);
      }, key);
    },
    refresh(tomb: string, key: CryptoKey) {
      if (keys.get(tomb) !== key)
        throw new VfsError(
          "locked",
          "The original tomb key is no longer admitted.",
        );
      assertTombRealmAuthority(tomb, key);
      recordRootGeneration(tomb, key, readHeader(tomb));
    },
    async authenticateRoot(
      tomb: string,
      owner: CryptoKey,
      raw: Uint8Array,
      check: () => void,
    ) {
      const storage = keys.get(tomb);
      if (!storage)
        throw new VfsError("locked", "The original tomb is locked.");
      const pin = pinKeyAuthority(() => keys.get(tomb), storage);
      const header = readHeader(tomb);
      const assertCurrent = () => {
        check();
        pin();
        assertTombRealmAuthority(tomb, owner);
        assertTombRealmAuthority(tomb, storage);
        if (readHeader(tomb) !== header)
          throw new VfsError(
            "locked",
            "The header changed during root authentication.",
          );
      };
      assertCurrent();
      const operation = await import("./vfs-root-proof.js");
      assertCurrent();
      await operation.proveCommonStoredRoot(
        raw,
        owner,
        storage,
        header,
        tomb,
        assertCurrent,
      );
      assertCurrent();
      recordRootGeneration(tomb, owner, header);
      recordRootGeneration(tomb, storage, header);
    },
  };
}
