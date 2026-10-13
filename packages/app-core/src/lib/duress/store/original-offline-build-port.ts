/** Original fixed worker/cache evidence DATA; never Root/Owner/readiness authority. */
export type OriginalOfflineBuildSnapshot = Readonly<{
  buildId: string;
  scopePath: string;
  assets: number;
  bytes: number;
}>;
export type OriginalOfflineBuildCapture = Readonly<{
  check(): void;
  read(): Promise<OriginalOfflineBuildSnapshot>;
  close(): Promise<void>;
}>;
export type OriginalOfflineBuildPort = Readonly<{
  capture(original: () => void): OriginalOfflineBuildCapture;
}>;
