/**
 * Which Identity plane is answering, and what it serves (ADR 0160).
 *
 * With no external Identity API in Settings, this device — the unlocked vault
 * in this browser — *is* the Identity plane for Pages' own features. With one,
 * that service is, and the device host is off (ADR 0118 §3). A panel that
 * asks "is a remote URL set?" is asking the wrong question; it wants to know
 * whether the plane that is answering serves *what the panel needs*.
 *
 * | family              | device                              | remote |
 * | ------------------- | ----------------------------------- | ------ |
 * | session             | always                              | yes    |
 * | audit, requests,    | while the owning capability is on   | yes    |
 * | notifications,      | (it registers the family)           |        |
 * | directory           |                                     |        |
 * | mfa-codes,          | never: each needs a server          | yes    |
 * | org-signin,         |                                     |        |
 * | federation-callback,|                                     |        |
 * | wallet              |                                     |        |
 *
 * `identityServes` answers whether a plane *can* serve a family, not whether
 * it is open right now: a locked vault still belongs to a device plane that
 * serves sessions, and answers `locked` when asked for one.
 */

import {
  type IdentityRouteFamily,
  registeredDeviceFamilies,
} from "./device-identity-routes.js";
import { isRemoteIdentityConfigured } from "./device-identity.js";

export {
  DEVICE_CORE_FAMILIES,
  DEVICE_NEVER_FAMILIES,
  IDENTITY_ROUTE_FAMILIES,
  type IdentityRouteFamily,
} from "./device-identity-routes.js";

export type IdentityPlaneKind = "device" | "remote";

/** `remote` when Settings names an Identity API, else `device`. */
export function identityPlane(): IdentityPlaneKind {
  return isRemoteIdentityConfigured() ? "remote" : "device";
}

/**
 * Does the plane that is answering serve this family?
 *
 * A remote plane is asked for everything: what it lacks it refuses over the
 * wire. The device plane serves its core, plus the families a capability that
 * is on has registered, and never what needs a server.
 */
export function identityServes(family: IdentityRouteFamily): boolean {
  if (identityPlane() === "remote") return true;
  if (family === "session") return true;
  return registeredDeviceFamilies().has(family);
}
