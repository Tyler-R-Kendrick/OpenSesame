/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_OPENSESAME_ISSUER?: string;
  readonly VITE_OPENSESAME_API_URL?: string;
  readonly VITE_CLIENT_ID?: string;
  readonly VITE_SECTOR?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
