/**
 * The Identity/Access panel's directory write, with its actor check. Records
 * (create, rename, enable, delete) need `manage_identity` and memberships
 * `manage_memberships`, decided for the acting person before the fence is
 * taken. Guest status is read from the display name, so an unchecked rename
 * would let a member — or a guest demoted beside a claimed operator — rename
 * the claimed owner into a "guest" and so make itself operator.
 *
 * It lives apart from `local-directory.ts` because the actor check reads
 * sessions, which read the directory: the commit primitive stays below both.
 */

import {
  type LocalDirectory,
  type LocalDirectoryChange,
  commitLocalDirectoryUnderLock,
  withLocalDirectoryLock,
} from "./local-directory.js";
import { assertDirectoryChangeAllowed } from "./local-rbac.js";

export async function changeLocalDirectory(
  tomb: string,
  revision: number,
  change: LocalDirectoryChange,
): Promise<LocalDirectory> {
  await assertDirectoryChangeAllowed(tomb, change);
  return withLocalDirectoryLock(tomb, () =>
    commitLocalDirectoryUnderLock(tomb, revision, change),
  );
}
