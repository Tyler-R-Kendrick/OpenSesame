/** Only dashboard-bound Basic credentials and the filtered first user page are admitted. */
function basicPair(profile) {
  const slot = profile.additionalCredentials[0];
  return (
    profile.auth?.kind === "basic" &&
    profile.auth.username === "{key}" &&
    profile.auth.password === "{admin_access_token}" &&
    profile.additionalCredentials.length === 1 &&
    slot.name === "admin_access_token" &&
    slot.required &&
    slot.secret
  );
}
function programField(profile, program) {
  const field = profile.templateParams[0];
  return (
    profile.templateParams.length === (program ? 1 : 0) &&
    (!program ||
      (field.name === "program_host" &&
        field.required &&
        !field.secret &&
        !field.choices))
  );
}
function profileMatches(profile, host, program) {
  const verify = profile.verify;
  return (
    basicPair(profile) &&
    programField(profile, program) &&
    verify?.method === "GET" &&
    verify.url ===
      `https://${host}/v3/users?count=10&start_index=0&fields=token%2Cactive` &&
    verify.body === null &&
    verify.auth === null &&
    verify.accountField === null &&
    Object.keys(verify.headers).length === 0
  );
}
export function marqetaReadContract(apiKey) {
  return Boolean(
    apiKey &&
      profileMatches(apiKey, "sandbox-api.marqeta.com", false) &&
      apiKey.serviceUrls.length === 2 &&
      apiKey.serviceUrls[0] === "https://sandbox-api.marqeta.com/v3" &&
      apiKey.serviceUrls[1] === "https://{program_host}/v3" &&
      apiKey.credentialVariants.length === 2 &&
      apiKey.credentialVariants[0].id === "sandbox" &&
      profileMatches(
        apiKey.credentialVariants[0],
        "sandbox-api.marqeta.com",
        false,
      ) &&
      apiKey.credentialVariants[1].id === "program" &&
      profileMatches(apiKey.credentialVariants[1], "{program_host}", true),
  );
}
