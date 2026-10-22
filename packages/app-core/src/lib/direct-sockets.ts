/**
 * Direct Sockets (WICG), available to Isolated Web Apps after the manifest's
 * `direct-sockets` permission and cross-origin isolation. This module only
 * opens the platform objects; authorization stays with the capability that
 * asked for a socket.
 *
 * The constructor types are local because the DOM lib does not ship them yet.
 */

export type DirectSocketAvailability =
  | "available"
  | "unavailable"
  | "unprompted";

type TcpOpen = {
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<BufferSource>;
};
type UdpMessage = {
  readonly data: Uint8Array;
  readonly remoteAddress: string | null;
  readonly remotePort: number | null;
};
type UdpOpen = {
  readonly readable: ReadableStream<UdpMessage>;
  readonly writable: WritableStream<UdpMessage>;
  readonly localPort?: number;
  readonly multicastController?: {
    joinGroup(address: string): Promise<void>;
    leaveGroup(address: string): Promise<void>;
  };
};
type TcpSocket = {
  readonly opened: Promise<TcpOpen>;
  close(): void | Promise<void>;
};
type UdpSocket = {
  readonly opened: Promise<UdpOpen>;
  close(): void | Promise<void>;
};
type TcpCtor = new (
  remoteAddress: string,
  remotePort: number,
  options?: {
    keepAlive?: boolean;
    keepAliveDelay?: number;
    noDelay?: boolean;
    sendBufferSize?: number;
    receiveBufferSize?: number;
  },
) => TcpSocket;
type TcpServerCtor = new (
  localAddress: string,
  options?: {
    localPort?: number;
    backlog?: number;
  },
) => {
  readonly opened: Promise<{ readable: ReadableStream<TcpSocket> }>;
  close(): void | Promise<void>;
};
type UdpCtor = new (options: {
  localAddress?: string;
  localPort?: number;
  remoteAddress?: string;
  remotePort?: number;
  multicastTimeToLive?: number;
  multicastLoopback?: boolean;
  multicastAllowAddressSharing?: boolean;
}) => UdpSocket;

type DirectSocketsHost = {
  TCPSocket?: TcpCtor;
  TCPServerSocket?: TcpServerCtor;
  UDPSocket?: UdpCtor;
};

function host(): DirectSocketsHost {
  return globalThis as DirectSocketsHost;
}

/** Whether this document is an `isolated-app://` bundle. */
export function isIsolatedWebApp(): boolean {
  return globalThis.location?.protocol === "isolated-app:";
}

/** Whether the Direct Sockets constructors are present in this context. */
export function directSocketsAvailability(): DirectSocketAvailability {
  if (!isIsolatedWebApp()) return "unavailable";
  if (host().TCPSocket === undefined && host().UDPSocket === undefined)
    return "unavailable";
  return "available";
}

export function directSocketsAvailable(): boolean {
  return directSocketsAvailability() === "available";
}

export function multicastDirectSocketsAvailable(): boolean {
  return (
    directSocketsAvailable() &&
    typeof host().UDPSocket === "function" &&
    typeof (host().UDPSocket as unknown as { prototype?: unknown })
      .prototype === "object"
  );
}

function port(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535)
    throw new RangeError("Direct socket port is outside 1-65535");
  return value;
}

/** Open a TCP client connection; the caller owns the streams and close(). */
export async function openTcpSocket(
  remoteAddress: string,
  remotePort: number,
  options?: ConstructorParameters<TcpCtor>[2],
): Promise<{ socket: TcpSocket; opened: TcpOpen }> {
  const Ctor = host().TCPSocket;
  if (Ctor === undefined) throw new Error("Direct Sockets are unavailable");
  const socket = new Ctor(remoteAddress, port(remotePort), options);
  return { socket, opened: await socket.opened };
}

/** Bind a UDP socket. Bound sockets accept datagrams from any peer. */
export async function openUdpSocket(
  options: ConstructorParameters<UdpCtor>[0],
): Promise<{
  socket: UdpSocket;
  opened: UdpOpen;
}> {
  const Ctor = host().UDPSocket;
  if (Ctor === undefined) throw new Error("Direct Sockets are unavailable");
  if (options.localPort !== undefined) port(options.localPort);
  if (options.remotePort !== undefined) port(options.remotePort);
  const socket = new Ctor(options);
  return { socket, opened: await socket.opened };
}

/** Start a TCP listener; each accepted value is a connected TCPSocket. */
export async function openTcpServer(
  localAddress: string,
  options?: ConstructorParameters<TcpServerCtor>[1],
): Promise<{
  server: { close(): void | Promise<void> };
  readable: ReadableStream<TcpSocket>;
}> {
  const Ctor = host().TCPServerSocket;
  if (Ctor === undefined) throw new Error("Direct Sockets are unavailable");
  const server = new Ctor(localAddress, options);
  const opened = await server.opened;
  return { server, readable: opened.readable };
}
