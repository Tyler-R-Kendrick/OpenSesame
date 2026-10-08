/**
 * A bucket saved on this device (Settings › Local storage) keeps the vault as
 * one file per secret, read before any header is (ADR 0182). With none saved
 * this is one small read and the emulated VFS stays; the file store itself
 * loads only when there is a bucket to open.
 */
export async function bootBucket(): Promise<void> {
  const { hasSavedBucket } = await import(
    "@opensesame/app-core/lib/secret-fs/bucket-saved.js"
  );
  if (!(await hasSavedBucket())) return;
  const { installSavedBucket } = await import(
    "@opensesame/app-core/lib/secret-fs/bucket-boot.js"
  );
  await installSavedBucket();
}
