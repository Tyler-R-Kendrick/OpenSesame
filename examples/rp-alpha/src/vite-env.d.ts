/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_OPENSESAME_ISSUER?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
