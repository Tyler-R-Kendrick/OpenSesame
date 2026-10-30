/** Bounds include base64 expansion around the shared drop format's 1 MiB payload ceiling. */
export const MAX_PORTABLE_MANIFEST_BYTES = 2 * 1024 * 1024;
export const MAX_PORTABLE_PACKET_CHARS = 4 * 1024 * 1024;
export const MAX_CODE_CIPHERTEXT_CHARS = Math.ceil(
  ((MAX_PORTABLE_MANIFEST_BYTES + 16) * 4) / 3,
);
export const MAX_PORTABLE_CODE_CHARS = 128;
