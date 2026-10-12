/**
 * Connections a live session's owner may let a device use (ADR 0196). Only
 * External connectors reads native authority, so only this file tells a
 * session which saved connections exist and how to call them; the session
 * itself (`sharing.live`) sees a port that offers nothing while this
 * capability is off, and holds no credential when it is on.
 */
import { bindConnectionPort } from "@opensesame/app-core/lib/live/connection-port.js";
import { sessionConnectionPort } from "@opensesame/app-core/lib/session-connections.js";
import type { Activation } from "../activation.js";

export function bindSessionConnections(activation: Activation): void {
  activation.onDispose(bindConnectionPort(sessionConnectionPort()));
}
