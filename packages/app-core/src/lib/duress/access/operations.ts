/**
 * AUTH-D operation helpers — prefer `./protect.js` for new call sites.
 * Kept for stable imports from access tests and older adapters.
 */

export {
  PROTECTED_OPERATIONS,
  assertProtectedOperation as assertProtectedOperationStrict,
  isProtectedOperation,
  withProtectedOperation,
  type ProtectedOperation,
  type ProtectCheckInput,
} from "./protect.js";

export { narrowCapabilities } from "./capability-narrow.js";
