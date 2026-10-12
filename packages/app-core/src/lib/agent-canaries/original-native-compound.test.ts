/** Genuine native encryption/decryption/decode plus independent forwarded wipe refusals. */
import { it } from "vitest";
import { owned } from "./original-indexed-leaf.test-support.js";
import {
  nativeAcceptAndDiscard,
  nativeDecodeAndWipe,
  nativeEncryptAndWipe,
} from "./original-native-compound.test-support.js";
it("retains undefined native encryption delivery and its opaque Promise cleanup refusal", () =>
  owned((f) =>
    nativeEncryptAndWipe(
      f,
      undefined,
      Promise.resolve("native encryption wipe refusal"),
    ),
  ));
it("retains opaque Promise original retirement and independently failed late native plaintext discard", () =>
  owned((f) =>
    nativeAcceptAndDiscard(
      f,
      Promise.resolve("original native retirement"),
      -0,
    ),
  ));
it("retains signed-zero post-native-decode refusal with independent NaN plaintext wipe refusal", () =>
  owned((f) => nativeDecodeAndWipe(f, -0, Number.NaN)));
