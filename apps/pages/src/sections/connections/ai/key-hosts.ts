/**
 * The host Test connection and Save send a pasted key to (ADR 0189 §2). It is
 * read from the request the connector runtime builds, not from the catalog's
 * `model_api` block: a provider may verify a key at one host and serve models
 * at another (Hugging Face verifies at `huggingface.co`, serves at
 * `router.huggingface.co`), and the key reaches the first.
 */
import {
  nativeApiTarget,
  providerUrl,
} from "@opensesame/app-core/lib/native-api-target.js";

/** A URL template's scheme and host: no path, no query, so no credential placeholder. */
const AUTHORITY = /^https:\/\/[^/?#]*/;

/**
 * The verify request's host for these public parameters, its tenant
 * placeholders filled and checked by the runtime's own helpers. `null` when the
 * runtime would not build the request (an unknown provider, a parameter it
 * refuses): no key can be sent then, so none is named.
 */
export function verifyHost(
  providerId: string,
  parameters: Record<string, string>,
): string | null {
  try {
    const target = nativeApiTarget(providerId, parameters);
    const authority = AUTHORITY.exec(target.profile.verify?.url ?? "")?.[0];
    return authority ? providerUrl(authority, target, {}).host : null;
  } catch {
    return null;
  }
}
