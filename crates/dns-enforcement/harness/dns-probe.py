#!/usr/bin/env python3
"""Send one DNS A query from a chosen source address and say how it was answered.

Blocky's `POST /api/query` always resolves as a single client — the server's own
— so it cannot show that two enforcement units are isolated from each other.
That takes real queries from two source addresses, which is all this does.

A `zeroIP` block is an A record of 0.0.0.0, so BLOCKED and RESOLVED are
distinguishable without trusting anything the resolver says about itself.

    python3 dns-probe.py both.example.org 127.0.0.1 55353
"""

import socket
import struct
import sys

BLOCKED_SENTINEL = "0.0.0.0"


def _encode_name(name: str) -> bytes:
    return b"".join(
        struct.pack("B", len(label)) + label.encode("ascii")
        for label in name.split(".")
    ) + b"\x00"


def _skip_name(data: bytes, offset: int) -> int:
    """Step over a name at `offset`, following the compression convention."""
    if data[offset] & 0xC0 == 0xC0:
        return offset + 2
    while data[offset] != 0:
        offset += data[offset] + 1
    return offset + 1


def query(name: str, resolver: tuple[str, int], source_ip: str, timeout: float = 5.0) -> str:
    message = (
        struct.pack(">HHHHHH", 0x1234, 0x0100, 1, 0, 0, 0)
        + _encode_name(name)
        + struct.pack(">HH", 1, 1)  # QTYPE=A, QCLASS=IN
    )

    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.settimeout(timeout)
    try:
        sock.bind((source_ip, 0))
        sock.sendto(message, resolver)
        data, _ = sock.recvfrom(4096)
    except socket.timeout:
        return "TIMEOUT"
    except OSError as error:
        return f"SOCKET_ERROR({error})"
    finally:
        sock.close()

    rcode = data[3] & 0x0F
    answers = struct.unpack(">H", data[6:8])[0]
    if rcode == 3:
        return "NXDOMAIN"
    if answers == 0:
        # SERVFAIL here means the filter let the name through and the (dead)
        # upstream could not answer it. That is "not blocked".
        return f"NOT_BLOCKED(rcode={rcode})"

    offset = _skip_name(data, 12) + 4  # question name, then QTYPE and QCLASS
    for _ in range(answers):
        offset = _skip_name(data, offset)
        rtype, _rclass, _ttl, rdlength = struct.unpack(">HHIH", data[offset : offset + 10])
        offset += 10
        if rtype == 1:
            address = ".".join(str(octet) for octet in data[offset : offset + 4])
            return f"BLOCKED({address})" if address == BLOCKED_SENTINEL else f"RESOLVED({address})"
        offset += rdlength
    return "NO_A_RECORD"


def main() -> int:
    if len(sys.argv) != 4:
        print(__doc__, file=sys.stderr)
        return 2
    name, source_ip, port = sys.argv[1], sys.argv[2], int(sys.argv[3])
    verdict = query(name, ("127.0.0.1", port), source_ip)
    print(f"{name:24} from {source_ip:12} -> {verdict}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
