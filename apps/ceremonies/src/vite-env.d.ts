/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_OPENSESAME_ISSUER?: string;
  readonly VITE_OPENSESAME_CONSOLE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
