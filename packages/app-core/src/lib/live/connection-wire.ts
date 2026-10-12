/**
 * What a connection looks like on the wire to a device (ADR 0196): the
 * grammar of its ids and operation names, the bounds on a frame's lists, and
 * the two shapes a device is told of. Kept apart from the messages that carry
 * them because two capabilities spell these the same way — the connections an
 * app holds (`connectors.external`) and the sessions that offer them
 * (`sharing.live`) — and neither may own the words the other must agree to.
 */

import { type BoundaryValue, isString } from "@opensesame/os-domain";

export const CONNECTION_ID = /^[A-Za-z0-9._:-]{1,128}$/;
export const PROVIDER_ID = /^[A-Za-z0-9._:-]{1,64}$/;
/** `provider.read`, `provider.repositories.read`: lower-case words and dots. */
const OPERATION_ID = /^[a-z][a-z0-9_]{0,31}(\.[a-z0-9_]{1,32}){0,5}$/;

export const CONNECTIONS_MAX = 32;
export const OPERATIONS_MAX = 16;

/** One connection as a device may be told of it: never a credential. */
export type DeviceConnection = Readonly<{
  id: string;
  label: string;
  provider: string;
  /** What a call may name on this connection, as the owner's tab allows. */
  operations: readonly string[];
}>;

/** One line of what an operation reported. */
export type DeviceItem = Readonly<{
  id: string;
  label: string;
  url?: string;
}>;

export function isOperationId(value: BoundaryValue): value is string {
  return isString(value) && value.length <= 192 && OPERATION_ID.test(value);
}
