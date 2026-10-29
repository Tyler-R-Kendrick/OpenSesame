/** Preserve usable minted credentials even when other token response fields are malformed. */
import type { OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { z } from "zod";
import { NativeMcpAuthError } from "./native-mcp-oauth-target.js";

const opaque = z
  .string()
  .min(1)
  .max(32768)
  .regex(/^[!-~]+$/);
const AccessSchema = z.object({ access_token: opaque });
const RefreshSchema = z.object({ refresh_token: opaque });
const PairSchema = AccessSchema.extend({ refresh_token: opaque.optional() });
const DetailsSchema = z.object({
  token_type: z.string().min(1),
  expires_in: z
    .number()
    .finite()
    .positive()
    .max(365 * 86400)
    .optional(),
  scope: z
    .string()
    .max(32768)
    .refine((scope) => {
      const values = scope.split(/\s+/).filter(Boolean);
      return (
        values.every((value) => value.length <= 512) &&
        new Set(values).size <= 256
      );
    })
    .optional(),
});
export type NativeMcpIssuedTokens = OAuthTokens & { protocolValid: boolean };
type TokenCapture = { value: NativeMcpIssuedTokens | null };

export async function captureNativeMcpTokenReply(
  action: (fetcher: typeof fetch) => Promise<OAuthTokens>,
  fetcher: typeof fetch,
  issuer: string,
  retainPartialRefresh?: (token: string) => Promise<void>,
): Promise<NativeMcpIssuedTokens> {
  const capture: TokenCapture = { value: null };
  let partialRefresh: string | null = null;
  const admitted: typeof fetch = async (input, init) => {
    const response = await fetcher(input, init);
    if (response.ok) {
      const body = await response.clone().json();
      const access = AccessSchema.safeParse(body);
      const pair = PairSchema.safeParse(body);
      const refresh = RefreshSchema.safeParse(body);
      if (!access.success && refresh.success)
        partialRefresh = refresh.data.refresh_token;
      if (access.success) {
        const details = DetailsSchema.safeParse(body);
        const validDetails = pair.success && details.success;
        capture.value = {
          ...access.data,
          token_type: validDetails ? details.data.token_type : "",
          issuer,
          protocolValid:
            validDetails && details.data.token_type.toLowerCase() === "bearer",
        };
        if (pair.success && pair.data.refresh_token)
          capture.value.refresh_token = pair.data.refresh_token;
        if (validDetails) {
          capture.value.expires_in = details.data.expires_in;
          capture.value.scope = details.data.scope;
        }
      }
    }
    return response;
  };
  try {
    await action(admitted);
  } catch (error) {
    if (!capture.value && !partialRefresh) throw error;
  }
  if (!capture.value && partialRefresh) {
    if (!retainPartialRefresh) throw new NativeMcpAuthError("storage");
    await retainPartialRefresh(partialRefresh);
    throw new NativeMcpAuthError("authorization");
  }
  if (!capture.value) throw new NativeMcpAuthError("authorization");
  return capture.value;
}
