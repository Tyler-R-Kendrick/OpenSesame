import { isNumber } from "@opensesame/os-domain";

export interface StoredTransaction {
  state: string;
  codeVerifier: string;
  nonce?: string;
  issuer?: string;
  redirectUri?: string;
  createdAt?: number;
}

export function assertCallbackTransaction(
  transaction: StoredTransaction,
  callback: URL,
  issuer: string,
  redirectUri: string,
) {
  const now = Date.now();
  if (
    transaction.issuer !== issuer ||
    transaction.redirectUri !== redirectUri ||
    !isNumber(transaction.createdAt) ||
    !Number.isFinite(transaction.createdAt) ||
    transaction.createdAt > now ||
    now - transaction.createdAt > 300_000
  )
    throw new Error(
      "OAuth transaction expired or addressed to a different client",
    );
  const callbackIssuer = callback.searchParams.get("iss");
  if (callbackIssuer !== null && callbackIssuer !== issuer)
    throw new Error("OAuth issuer mismatch");
  const actualRedirect = new URL(callback);
  for (const name of [
    "code",
    "state",
    "iss",
    "error",
    "error_description",
    "session_state",
  ])
    actualRedirect.searchParams.delete(name);
  actualRedirect.hash = "";
  if (actualRedirect.href !== new URL(redirectUri).href)
    throw new Error("OAuth redirect mismatch");
  for (const name of ["code", "state", "iss", "error"]) {
    if (callback.searchParams.getAll(name).length > 1)
      throw new Error("Ambiguous OAuth callback");
  }
}
