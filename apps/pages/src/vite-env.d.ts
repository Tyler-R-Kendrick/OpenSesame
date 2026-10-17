/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

interface ImportMetaEnv {
  readonly VITE_PWA_OFFER_PASSWORDS_ONBOARDING?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
