/** Original member-operation checks; no response proxies or new server policy. */
import { assertNotDecoySession, withRealAuthority } from "./decoy-session.js";
export function captureRealAuthority(): () => void {
  const generation = assertNotDecoySession();
  return () => {
    assertNotDecoySession(generation);
  };
}
export function authorityStillCurrent(check: () => void): boolean {
  try {
    check();
    return true;
  } catch {
    return false;
  }
}
export function authenticatedResult<T>(work: () => Promise<T>): Promise<T> {
  return withRealAuthority(work);
}
