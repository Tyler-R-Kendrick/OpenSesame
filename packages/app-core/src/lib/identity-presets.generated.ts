// Generated from spec/connectors/identity-presets.json; do not edit.
import type { IdentityConnectionPreset } from "./identity-connections-presets.js";
export const IDENTITY_CONNECTION_PRESETS: readonly IdentityConnectionPreset[] =
  [
    {
      id: "byo-identity",
      label: "BYO Identity",
      protocols: ["oidc", "saml", "ldap", "better-auth", "supabase"],
      issuerPlaceholder: "https://identity.example.com",
      baseUrlPlaceholder: "https://identity.example.com/api/auth",
      setup:
        "Register this app as a public client with authorization code and S256 PKCE. Allow its redirect URI and browser origin. The issuer must publish OpenID Connect discovery.",
      docsUrl: "https://openid.net/specs/openid-connect-core-1_0.html",
    },
    {
      id: "better-auth",
      label: "Better Auth",
      protocols: ["better-auth", "oidc"],
      issuerPlaceholder: "https://identity.example.com/api/auth",
      baseUrlPlaceholder: "https://identity.example.com/api/auth",
      setup:
        "Use your Better Auth API base URL. Enable email/password and the JWT plugin, and add this app to trustedOrigins with credentialed CORS. For OIDC, install the OAuth Provider plugin and register a public client.",
      docsUrl: "https://www.better-auth.com/docs/plugins/jwt",
    },
    {
      id: "supabase",
      label: "Supabase Auth",
      protocols: ["supabase", "oidc"],
      issuerPlaceholder: "https://project.supabase.co/auth/v1",
      baseUrlPlaceholder: "https://project.supabase.co",
      setup:
        "Use your Supabase project URL and publishable or anon key, with Email provider enabled. For OIDC, enable Supabase OAuth Server and register a public application with this redirect URI.",
      docsUrl: "https://supabase.com/docs/guides/auth",
    },
    {
      id: "neon-auth",
      label: "Neon Auth",
      protocols: ["better-auth"],
      issuerPlaceholder:
        "https://branch.neonauth.us-east-1.aws.neon.tech/neondb/auth",
      baseUrlPlaceholder:
        "https://branch.neonauth.us-east-1.aws.neon.tech/neondb/auth",
      setup:
        "Copy this branch's Neon Auth URL from the dashboard and register this app as a trusted origin. Neon Auth uses the Better Auth session API and JWT signing keys.",
      docsUrl: "https://neon.com/docs/auth/overview",
    },
    {
      id: "clerk",
      label: "Clerk",
      protocols: ["oidc"],
      issuerPlaceholder: "https://clerk.example.com",
      baseUrlPlaceholder: "",
      setup:
        "Create a Clerk OAuth application, enable OpenID Connect, and use its issuer and client ID. Register a public client with PKCE and this redirect URI.",
      docsUrl:
        "https://clerk.com/docs/guides/configure/auth-strategies/oauth/how-clerk-implements-oauth",
    },
    {
      id: "auth0",
      label: "Auth0",
      protocols: ["oidc", "saml"],
      issuerPlaceholder: "https://acme.us.auth0.com",
      baseUrlPlaceholder: "",
      setup:
        "Create an Auth0 Single Page Application. Register the callback and Allowed Web Origins, select token endpoint authentication None, and use the tenant domain as issuer.",
      docsUrl:
        "https://auth0.com/docs/get-started/applications/application-settings",
    },
    {
      id: "workos",
      label: "WorkOS",
      protocols: ["oidc", "saml"],
      issuerPlaceholder: "https://signin.workos.com",
      baseUrlPlaceholder: "",
      setup:
        "Use your AuthKit Connect issuer and register a public OAuth application with PKCE and this redirect URI. Confidential applications and SAML use your organization sign-in service.",
      docsUrl: "https://workos.com/docs/authkit/connect/oauth",
    },
    {
      id: "okta",
      label: "Okta",
      protocols: ["oidc", "saml"],
      issuerPlaceholder: "https://acme.okta.com/oauth2/default",
      baseUrlPlaceholder: "",
      setup:
        "Create an OIDC Single-Page Application with authorization code and PKCE. Register the callback and Trusted Origin. Use the authorization server's issuer URI.",
      docsUrl: "https://developer.okta.com/docs/guides/sign-into-spa-redirect/",
    },
  ];
