/** Only the two official environments and fixed non-PCI first page are admitted. */
function profileMatches(profile, host) {
  const verify = profile.verify;
  return (
    profile.auth?.kind === "header" &&
    profile.auth.header === "Authorization" &&
    profile.auth.scheme === null &&
    profile.auth.valueTemplate === null &&
    profile.templateParams.length === 0 &&
    profile.additionalCredentials.length === 0 &&
    verify?.method === "GET" &&
    verify.url === `https://${host}.lithic.com/v1/cards?page_size=20` &&
    verify.body === null &&
    verify.auth === null &&
    verify.accountField === null &&
    Object.keys(verify.headers).length === 1 &&
    verify.headers["api-version"] === "2026-07-01"
  );
}
export function lithicReadContract(apiKey) {
  return Boolean(
    apiKey &&
      profileMatches(apiKey, "sandbox") &&
      apiKey.serviceUrls.length === 2 &&
      apiKey.serviceUrls[0] === "https://sandbox.lithic.com/v1" &&
      apiKey.serviceUrls[1] === "https://api.lithic.com/v1" &&
      apiKey.credentialVariants.length === 2 &&
      apiKey.credentialVariants[0].id === "sandbox" &&
      profileMatches(apiKey.credentialVariants[0], "sandbox") &&
      apiKey.credentialVariants[1].id === "production" &&
      profileMatches(apiKey.credentialVariants[1], "api"),
  );
}
