/** Preserve usable minted credentials even when other token response fields are malformed. */
import type { OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { z } from "zod";
import { NativeMcpAuthError } from "./native-mcp-oauth-target.js";

const opaque = z
  .string()
  .min(1)
  .max(32768)
  .regex(/^[!-~]+$/);
const PairSchema = z.object({
  access_token: opaque,
  refresh_token: opaque.optional(),
});
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
    .refine((scope) => scope.split(/\s+/).every((value) => value.length <= 512))
    .optional(),
});
export type NativeMcpIssuedTokens = OAuthTokens & { protocolValid: boolean };
type TokenCapture = { value: NativeMcpIssuedTokens | null };

export async function captureNativeMcpTokenReply(
  action: (fetcher: typeof fetch) => Promise<OAuthTokens>,
  fetcher: typeof fetch,
  issuer: string,
): Promise<NativeMcpIssuedTokens> {
  const capture: TokenCapture = { value: null };
  const admitted: typeof fetch = async (input, init) => {
    const response = await fetcher(input, init);
    if (response.ok) {
      const body = await response.clone().json();
      const pair = PairSchema.safeParse(body);
      if (pair.success) {
        const details = DetailsSchema.safeParse(body);
        capture.value = {
          ...pair.data,
          token_type: details.success ? details.data.token_type : "",
          issuer,
          protocolValid:
            details.success &&
            details.data.token_type.toLowerCase() === "bearer",
        };
        if (details.success) {
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
    if (!capture.value) throw error;
  }
  if (!capture.value) throw new NativeMcpAuthError("authorization");
  return capture.value;
}
