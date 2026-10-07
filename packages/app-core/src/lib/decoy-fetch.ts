import { assertNotDecoySession } from "./decoy-session.js";

/** Explicit adapter for authority-bearing raw HTTP calls, never a global fetch override. */
export async function decoyGuardedFetch(
  ...args: Parameters<typeof fetch>
): Promise<Response> {
  const authorityGeneration = assertNotDecoySession();
  const response = await fetch(...args);
  assertNotDecoySession(authorityGeneration);
  return response;
}

/** The same boundary around an explicitly supplied SDK or test transport. */
export async function guardedFetchUsing(
  fetchImpl: typeof fetch,
  ...args: Parameters<typeof fetch>
): Promise<Response> {
  const authorityGeneration = assertNotDecoySession();
  const response = await fetchImpl(...args);
  assertNotDecoySession(authorityGeneration);
  return response;
}
