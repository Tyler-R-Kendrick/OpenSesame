/** Shared native SAML configuration; partner presets and BYO consume the same fields and policy. */
import { z } from "zod";

export const SAML_PERSISTENT_NAME_ID =
  "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent";
export const SAML_NATIVE_FIELDS = {
  samlNameIdFormat: z.string().max(2048).default(SAML_PERSISTENT_NAME_ID),
  samlAuthnContext: z.string().max(2048).default(""),
  samlForceAuthentication: z.enum(["false", "true"]).default("false"),
  samlSigningPrivateKeyPkcs8: z.string().max(16384).default(""),
  samlSigningCertificate: z.string().max(16384).default(""),
};
const configuration = z.object({
  clientId: z.string().max(2048),
  samlEntityId: z.string().max(2048),
  samlMetadataXml: z.string().max(262144),
  samlMetadataUrl: z.string().max(2048),
  ...SAML_NATIVE_FIELDS,
});
export type NativeSamlConfiguration = z.infer<typeof configuration>;
/** Entity IDs are identifiers, not HTTPS transport endpoints: legitimate IdPs also use URNs and HTTP IDs. */
export function samlEntityIdentifier(value: string): boolean {
  if (!value || value.length > 2048 || value.trim() !== value) return false;
  for (const character of value)
    if (character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127)
      return false;
  try {
    const uri = new URL(value);
    return (
      !["javascript:", "data:", "vbscript:", "file:"].includes(uri.protocol) &&
      !uri.username &&
      !uri.password
    );
  } catch {
    return false;
  }
}
/** Public metadata URLs may contain a provider's ordinary tenant query; credentials and fragments are forbidden. */
export function samlMetadataEndpoint(value: string): boolean {
  if (!samlEntityIdentifier(value)) return false;
  try {
    const url = new URL(value);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    return (
      !url.username &&
      !url.password &&
      !url.hash &&
      (url.protocol === "https:" || (url.protocol === "http:" && loopback))
    );
  } catch {
    return false;
  }
}
/** Syntax/configuration validation only. Metadata/key crypto and actual sign-in remain separate operations. */
export function nativeSamlConfigurationProblems(
  input: NativeSamlConfiguration,
): string[] {
  const parsed = configuration.safeParse(input);
  if (!parsed.success) return ["Invalid SAML configuration"];
  const draft = parsed.data;
  const problems: string[] = [];
  if (!samlEntityIdentifier(draft.samlEntityId))
    problems.push("Enter the SAML identity provider entity ID");
  if (!samlEntityIdentifier(draft.clientId))
    problems.push("Enter your registered SAML service provider entity ID");
  if (!draft.samlMetadataXml && !samlMetadataEndpoint(draft.samlMetadataUrl))
    problems.push("Enter an HTTPS SAML metadata URL or metadata XML");
  if (draft.samlMetadataXml && draft.samlMetadataUrl)
    problems.push("Choose metadata URL or XML, not both");
  if (!samlEntityIdentifier(draft.samlNameIdFormat))
    problems.push("Enter the SAML NameID format URI");
  if (draft.samlAuthnContext && !samlEntityIdentifier(draft.samlAuthnContext))
    problems.push("Use an authentication context URI or leave it empty");
  if (!!draft.samlSigningPrivateKeyPkcs8 !== !!draft.samlSigningCertificate)
    problems.push(
      "Request signing needs both the SP private key and certificate",
    );
  return problems;
}
