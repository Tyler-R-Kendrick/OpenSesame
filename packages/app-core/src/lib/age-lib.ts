/**
 * The one door to `age-encryption`.
 *
 * The library (and the noble curves it carries) is only needed when an age key
 * is read, made, validated or used: unlocking with an age protector, the SOPS
 * engine, the age keys panel. The entry chunk therefore never imports it; this
 * module loads it on first use and keeps the promise, so a second caller waits
 * for the same load. Nothing else in the repository may import the package
 * directly (`age-lib.test.ts` holds that line).
 */

type AgeLibrary = typeof import("age-encryption");

let loading: Promise<AgeLibrary> | undefined;

export function loadAge(): Promise<AgeLibrary> {
  loading ??= import("age-encryption");
  return loading;
}
