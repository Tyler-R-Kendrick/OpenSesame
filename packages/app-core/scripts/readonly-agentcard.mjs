/** Platform authority is separate from member-card credentials and payment operations. */
function requestMatches(verify) {
  return (
    verify?.method === "GET" &&
    verify.url === "https://api.agentcard.sh/api/v2" &&
    verify.accountField === "organization_id" &&
    verify.body === null &&
    verify.auth === null &&
    Object.keys(verify.headers).length === 0
  );
}
export function agentcardReadContract(apiKey) {
  return Boolean(
    apiKey &&
      apiKey.auth?.kind === "header" &&
      apiKey.auth.header === "Authorization" &&
      apiKey.auth.scheme === "Bearer" &&
      apiKey.auth.valueTemplate === null &&
      apiKey.templateParams.length === 0 &&
      apiKey.additionalCredentials.length === 0 &&
      apiKey.credentialVariants.length === 0 &&
      apiKey.serviceUrls.length === 1 &&
      apiKey.serviceUrls[0] === "https://api.agentcard.sh" &&
      requestMatches(apiKey.verify),
  );
}
