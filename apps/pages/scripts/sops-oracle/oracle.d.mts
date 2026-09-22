export const SOPS_VERSION: string;
export const SOPS_SOURCE_COMMIT: string;
export const CHECKSUMS: Record<string, [string, string]>;
export function oracleCacheDir(): string;
export function provisionOracle(options?: { allowDownload?: boolean }):
  | { bin: string; sha256: string; name: string; error?: undefined }
  | { error: string; bin?: undefined; sha256?: undefined; name?: undefined };
export function runSops(
  bin: string,
  options: {
    args: string[];
    input: string;
    inputName?: string;
    identities?: string[];
    config?: string | null;
    timeoutMs?: number;
    readBack?: boolean;
  },
): {
  status: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  file: string | null;
};
export function provisionTreedump():
  | { bin: string; error?: undefined }
  | { error: string; bin?: undefined };
export function runTreedump(
  bin: string,
  format: string,
  input: string,
  inputName?: string,
): unknown;
