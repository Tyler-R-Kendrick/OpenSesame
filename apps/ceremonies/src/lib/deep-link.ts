/**
 * Deep-link parsing lives in `@opensesame/ceremony-kit` so Pages and the
 * console read a ceremony link exactly the way this app does. Re-exported here
 * to keep the pages' imports local.
 */
export { parseUserCode, readFragmentToken } from "@opensesame/ceremony-kit";
