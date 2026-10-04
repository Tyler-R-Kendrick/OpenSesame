/** The slice of `http_ece` (RFC 8188) the stand-in push service uses. */
declare module "http_ece" {
  import type { ECDH } from "node:crypto";

  interface DecryptParams {
    version: "aes128gcm";
    /** The user agent's key pair, as a Node `ECDH` object. */
    privateKey: ECDH;
    /** The subscription's 16-byte auth secret, base64url. */
    authSecret: string;
  }

  export function decrypt(body: Buffer, params: DecryptParams): Buffer;

  const ece: { decrypt: typeof decrypt };
  export default ece;
}
