/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

interface ImportMetaEnv {
  /** `1` or `true` ships the fresh-vault Passwords offer. Unset omits it. */
  readonly VITE_PWA_OFFER_PASSWORDS_ONBOARDING?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
