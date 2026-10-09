/**
 * Deliberately empty.
 *
 * Main once carried a `ClaimOpen` here: the vault header's share-shaped key
 * that opened `/claim` ("Accept a claim", PR #784). Sharing was restored as
 * PAM grants and secret drops (`VaultShareKey.tsx`), and `/claim` is only the
 * recipient's side of a drop link. This stub holds the path so merging over
 * main conflicts on the file and drops the claim entry instead of reviving
 * it. Do not reintroduce an export here.
 */
export {};
