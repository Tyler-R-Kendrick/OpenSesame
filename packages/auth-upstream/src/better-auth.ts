import { betterAuth } from "better-auth";
import type { PrincipalMappingStore } from "./mapping.js";
import { noEmailAutoLinkPolicy } from "./email-link.js";
import type { UpstreamOidcProviderRegistry } from "./oidc-registry.js";
import type { PasskeySeam } from "./passkey.js";

export interface CreateUpstreamAuthOptions {
  baseURL: string;
  secret: string;
  mappingStore: PrincipalMappingStore;
  providerRegistry?: UpstreamOidcProviderRegistry;
  passkeySeam?: PasskeySeam;
  /**
   * When true, configure Better Auth anonymous plugin surface if available.
   * Mapping layer always supports provisional principals independently.
   */
  enableAnonymous?: boolean;
}

/**
 * Better Auth instance wired for OpenSesame upstream human auth.
 * Account linking by email is disabled; principal IDs live in PrincipalMappingStore.
 */
export function createUpstreamAuth(options: CreateUpstreamAuthOptions) {
  const socialProviders = options.providerRegistry?.toBetterAuthSocialConfig() ?? {};

  const auth = betterAuth({
    baseURL: options.baseURL,
    secret: options.secret,
    emailAndPassword: {
      enabled: false,
    },
    socialProviders,
    account: {
      accountLinking: {
        enabled: false,
        trustedProviders: [],
      },
    },
  });

  return {
    auth,
    mappingStore: options.mappingStore,
    passkeySeam: options.passkeySeam,
    emailLinkPolicy: noEmailAutoLinkPolicy,
    providerRegistry: options.providerRegistry,
  };
}

export type UpstreamAuthBundle = ReturnType<typeof createUpstreamAuth>;
