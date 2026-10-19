/** Required private slots and fixed Basic injection share the common native form. */
function basicPair(apiKey) {
  return (
    apiKey.auth?.kind === "basic" &&
    apiKey.auth.username === "{key}" &&
    apiKey.auth.password === "{key_secret}" &&
    apiKey.additionalCredentials.length === 1 &&
    apiKey.additionalCredentials[0].name === "key_secret" &&
    apiKey.additionalCredentials[0].required &&
    apiKey.additionalCredentials[0].secret
  );
}

/** Admit only the native, bounded Basic-auth payment inventory contract. */
export function razorpayReadContract(apiKey) {
  return (
    apiKey?.verify?.method === "GET" &&
    apiKey.verify.url ===
      "https://api.razorpay.com/v1/payments?count=20&skip=0" &&
    apiKey.verify.body === null &&
    Object.keys(apiKey.verify.headers).length === 0 &&
    apiKey.verify.auth === null &&
    apiKey.serviceUrls.length === 1 &&
    apiKey.serviceUrls[0] === "https://api.razorpay.com" &&
    apiKey.templateParams.length === 0 &&
    apiKey.credentialVariants.length === 0 &&
    basicPair(apiKey)
  );
}
