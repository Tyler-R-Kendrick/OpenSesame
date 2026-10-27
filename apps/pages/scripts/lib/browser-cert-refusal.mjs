/** Distinguish a client-certificate handshake failure from HTTP admission or network failure. */
export function isClientCertificateRefusal({ status, error = "", body = "" }) {
  if (status !== 0 && status !== 503) return false;
  if (status === 0 && /\bnet::ERR_BAD_SSL_CLIENT_AUTH_CERT\b/.test(error))
    return true;
  if (status === 0 && /certificate required/i.test(error)) return true;
  return (
    /Playwright client-certificate error:/.test(body) &&
    /certificate required/i.test(body)
  );
}
