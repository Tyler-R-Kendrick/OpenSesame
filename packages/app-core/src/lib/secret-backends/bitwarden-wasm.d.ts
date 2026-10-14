declare module "@bitwarden/sdk-wasm/bitwarden_wasm_bg.js" {
  export { BitwardenClient, LogLevel } from "@bitwarden/sdk-wasm";
  export function __wbg_set_wasm(exports: WebAssembly.Exports): void;
}
declare module "@bitwarden/sdk-wasm/bitwarden_wasm_bg.wasm?url" {
  const url: string;
  export default url;
}
