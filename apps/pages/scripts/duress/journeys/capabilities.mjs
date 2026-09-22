/**
 * BROWSER-QA-C: capability matrix — WebCrypto + virtual authenticator probe.
 * Does not claim physical biometrics or hardware PRF.
 */
export async function walkCapabilities({ page, context, check, record }) {
  const webcrypto = await page.evaluate(async () => {
    return window.__duressQa.webcryptoProbe();
  });
  check(webcrypto.crypto === true, "globalThis.crypto present");
  check(webcrypto.subtle === true, "crypto.subtle present");
  check(webcrypto.pbkdf2 === true, "PBKDF2 deriveBits available");
  check(webcrypto.aesGcm === true, "AES-GCM encrypt available");
  check(webcrypto.hkdf === true, "HKDF deriveBits available");
  check(webcrypto.ecdsa === true, "ECDSA sign available");
  check(webcrypto.getRandomValues === true, "getRandomValues available");

  let virtualAuthenticator = {
    supported: false,
    reason: "CDP WebAuthn.enable not attempted",
  };
  try {
    const client = await context.newCDPSession(page);
    await client.send("WebAuthn.enable");
    const { authenticatorId } = await client.send(
      "WebAuthn.addVirtualAuthenticator",
      {
        options: {
          protocol: "ctap2",
          transport: "internal",
          hasResidentKey: true,
          hasUserVerification: true,
          isUserVerified: true,
        },
      },
    );
    virtualAuthenticator = {
      supported: true,
      authenticatorId,
      note: "virtual authenticator only — not physical biometrics/PRF hardware",
    };
    await client.send("WebAuthn.removeVirtualAuthenticator", {
      authenticatorId,
    });
    await client.send("WebAuthn.disable");
  } catch (error) {
    virtualAuthenticator = {
      supported: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  record("capability", JSON.stringify({ webcrypto, virtualAuthenticator }));
  check(
    true,
    virtualAuthenticator.supported
      ? "virtual authenticator available (not physical UV/PRF)"
      : `virtual authenticator unsupported: ${virtualAuthenticator.reason}`,
  );

  return { webcrypto, virtualAuthenticator };
}
