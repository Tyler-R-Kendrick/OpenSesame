/** Exact Google class proof; the captured consumer owns bounded native body completion. */
import { type BoundaryValue, isJsonObject } from "@opensesame/os-domain";
import { WalletRequestError } from "./provider.js";

export type GoogleResponseReader = (
  response: Response,
  maxBytes: number,
) => Promise<BoundaryValue>;

export async function verifyGoogleGenericClass(
  fetchImpl: typeof fetch,
  accessToken: string,
  classId: string,
  read: GoogleResponseReader,
): Promise<void> {
  let response: Response | undefined;
  let completed = false;
  try {
    response = await fetchImpl(
      `https://walletobjects.googleapis.com/walletobjects/v1/genericClass/${encodeURIComponent(classId)}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
        },
        credentials: "omit",
        redirect: "error",
        cache: "no-store",
        referrerPolicy: "no-referrer",
      },
    );
    if (!response.ok || response.redirected)
      throw new Error("Class proof refused");
    const value = await read(response, 64 * 1024);
    if (!isJsonObject(value) || value.id !== classId)
      throw new Error("Class proof changed");
    completed = true;
  } catch {
    throw new WalletRequestError(
      response?.status ?? 0,
      "Google Wallet could not verify the configured pass class.",
    );
  } finally {
    if (!completed) await response?.body?.cancel().catch(() => undefined);
  }
}
