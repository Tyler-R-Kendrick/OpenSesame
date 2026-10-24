/** Validate the actual token response before using it as issuer authority. */
import {
  type BoundaryValue,
  isJsonObject,
  isNumber,
  isString,
} from "@opensesame/os-domain";
import { WalletRequestError } from "./provider.js";

export function readGoogleTokenReply(body: BoundaryValue, status: number) {
  if (
    !isJsonObject(body) ||
    !isString(body.access_token) ||
    body.access_token.length === 0
  )
    throw new WalletRequestError(
      status,
      "Google's token response carried no access token.",
    );
  const lifetime = body.expires_in === undefined ? 3600 : body.expires_in;
  if (!isNumber(lifetime) || !Number.isFinite(lifetime) || lifetime <= 0)
    throw new WalletRequestError(
      status,
      "Google's token response carried an invalid expiry.",
    );
  return { value: body.access_token, lifetime };
}
