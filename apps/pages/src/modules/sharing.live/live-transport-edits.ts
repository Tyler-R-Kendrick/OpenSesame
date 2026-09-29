/**
 * The Routes Form's edits (ADR 0150 §6), each a pure function of the profile
 * as it is when the edit's turn comes (`live-transport-hooks.ts`). Adding
 * what is already there changes nothing; removing names the entry, not its
 * place in a list that may have moved on.
 */

import {
  type CarrierSpec,
  type IceServerSetting,
  type LiveTransport,
  carrierKey,
  iceKey,
} from "@opensesame/app-core/lib/live/transport.js";

export function withAddress(
  transport: LiveTransport,
  address: string,
): LiveTransport {
  if (transport.addresses.includes(address)) return transport;
  return { ...transport, addresses: [...transport.addresses, address] };
}

export function withoutAddress(
  transport: LiveTransport,
  address: string,
): LiveTransport {
  return {
    ...transport,
    addresses: transport.addresses.filter((entry) => entry !== address),
  };
}

export function withServer(
  transport: LiveTransport,
  server: IceServerSetting,
): LiveTransport {
  if (transport.ice.some((entry) => iceKey(entry) === iceKey(server)))
    return transport;
  return { ...transport, ice: [...transport.ice, server] };
}

const isTurn = (server: IceServerSetting): boolean =>
  server.urls.some((url) => url.startsWith("turn"));

/** Without the server; relay only goes with it when no TURN server is left. */
export function withoutServer(
  transport: LiveTransport,
  server: IceServerSetting,
): LiveTransport {
  const ice = transport.ice.filter((entry) => iceKey(entry) !== iceKey(server));
  return { ...transport, ice, relay: transport.relay && ice.some(isTurn) };
}

export function withCarrier(
  transport: LiveTransport,
  carrier: CarrierSpec,
): LiveTransport {
  if (
    transport.carriers.some(
      (entry) => carrierKey(entry) === carrierKey(carrier),
    )
  )
    return transport;
  return { ...transport, carriers: [...transport.carriers, carrier] };
}

export function withoutCarrier(
  transport: LiveTransport,
  carrier: CarrierSpec,
): LiveTransport {
  return {
    ...transport,
    carriers: transport.carriers.filter(
      (entry) => carrierKey(entry) !== carrierKey(carrier),
    ),
  };
}
