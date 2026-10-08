import {
  currentRealmGeneration,
  currentSyntheticTransition,
  isDecoySession,
} from "./decoy-session.js";
import { VfsError } from "./vfs-errors.js";
/** A sealed-data continuation retains its original admitted key and tab realm. */
export function pinKeyAuthority(
  read: () => CryptoKey | undefined,
  key: CryptoKey,
): () => void {
  const realm = currentRealmGeneration();
  const transition = currentSyntheticTransition();
  return () => {
    if (
      read() !== key ||
      currentRealmGeneration() !== realm ||
      transition !== currentSyntheticTransition()
    )
      throw new VfsError(
        "locked",
        "The vault session changed. Authenticate again.",
      );
  };
}

const admissions = new WeakMap<CryptoKey, number>();
export function recordKeyAdmission(key: CryptoKey): void {
  admissions.set(key, currentSyntheticTransition());
}

let syntheticAdmission: { tomb: string; key: CryptoKey; realm: number } | null =
  null;
/** Only the freshly minted synthetic scratch root is usable in its realm. */
export function admitSyntheticTombAuthority(
  tomb: string,
  key: CryptoKey,
): void {
  syntheticAdmission = { tomb, key, realm: currentRealmGeneration() };
}
export function tombRealmAuthorized(
  tomb: string,
  key: CryptoKey | null,
): boolean {
  const admitted = key ? admissions.get(key) : undefined;
  if (admitted !== undefined && admitted !== currentSyntheticTransition())
    return false;
  return (
    !isDecoySession() ||
    (syntheticAdmission?.tomb === tomb &&
      syntheticAdmission.key === key &&
      syntheticAdmission.realm === currentRealmGeneration())
  );
}
export function assertTombRealmAuthority(tomb: string, key: CryptoKey): void {
  if (!tombRealmAuthorized(tomb, key))
    throw new VfsError(
      "locked",
      "This synthetic session cannot access that tomb.",
    );
}
