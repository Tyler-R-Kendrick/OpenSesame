#!/usr/bin/env python3
"""Plumbing for verify:live-netns: veth pairs between network namespaces.

`ip` (iproute2) is not something a test may assume, so this speaks rtnetlink
directly with the standard library — no third-party package, no privilege
beyond CAP_NET_ADMIN over the namespaces (root inside the user namespace the
runner made). A namespace is named by the pid of a process living in it; pid
`0` is the namespace this script runs in.

    netns-plumb.py lo    PID
    netns-plumb.py veth  PIDA:DEV:CIDR  PIDB:DEV:CIDR  [--multicast]
    netns-plumb.py alias PID DEV CIDR
    netns-plumb.py route PID GATEWAY DEV
    netns-plumb.py down  PID DEV
    netns-plumb.py show  PID
    netns-plumb.py reach SRC_PID DST_PID DST_IP

Every veth end is created UP with IFF_MULTICAST cleared unless `--multicast`:
an interface like a tailnet's, which carries no mDNS.
"""

import contextlib
import ctypes
import fcntl
import json
import os
import socket
import struct
import sys
import threading

CLONE_NEWNET = 0x40000000
IFF_UP, IFF_MULTICAST = 0x1, 0x1000
NLM_F_REQUEST, NLM_F_ACK, NLM_F_EXCL, NLM_F_CREATE = 0x1, 0x4, 0x200, 0x400
RTM_NEWLINK, RTM_NEWADDR, RTM_NEWROUTE = 16, 20, 24
NLA_F_NESTED = 0x8000
LIBC = ctypes.CDLL(None, use_errno=True)


def attr(kind, payload, nested=False):
    size = 4 + len(payload)
    pad = b"\0" * (-size % 4)
    flag = NLA_F_NESTED if nested else 0
    return struct.pack("HH", size, kind | flag) + payload + pad


def cstr(text):
    return text.encode() + b"\0"


def reason(reply):
    """The kernel's own words (extended ACK) for a NAK, when it gave any."""
    _, _, flags, _, _ = struct.unpack("IHHII", reply[:16])
    (length,) = struct.unpack("I", reply[20:24])
    at = 20 + (16 if flags & 0x100 else length)  # NLM_F_CAPPED echoes the header
    while at + 4 <= len(reply):
        size, kind = struct.unpack("HH", reply[at : at + 4])
        if kind == 1 and size > 4:  # NLMSGERR_ATTR_MSG
            return reply[at + 4 : at + size].rstrip(b"\0").decode()
        at += (size + 3) & ~3 or 4
    return ""


def talk(kind, flags, body):
    """One rtnetlink request in the current namespace; raises on a kernel NAK."""
    with socket.socket(socket.AF_NETLINK, socket.SOCK_RAW, 0) as sock:
        sock.setsockopt(270, 11, 1)  # SOL_NETLINK, NETLINK_EXT_ACK
        sock.bind((0, 0))
        head = struct.pack(
            "IHHII", 16 + len(body), kind, NLM_F_REQUEST | NLM_F_ACK | flags, 1, 0
        )
        sock.send(head + body)
        reply = sock.recv(4096)
    _, code, _, _, _ = struct.unpack("IHHII", reply[:16])
    if code == 2:  # NLMSG_ERROR
        (errno,) = struct.unpack("i", reply[16:20])
        if errno:
            raise OSError(-errno, f"{os.strerror(-errno)} {reason(reply)}".strip())


def ifinfo(index=0, flags=0, change=0):
    return struct.pack("BxHiII", socket.AF_UNSPEC, 0, index, flags, change)


@contextlib.contextmanager
def inside(pid):
    """Run the body in pid's network namespace (this thread only)."""
    if pid == 0:
        yield
        return
    home = os.open("/proc/thread-self/ns/net", os.O_RDONLY)
    target = os.open(f"/proc/{pid}/ns/net", os.O_RDONLY)
    try:
        if LIBC.setns(target, CLONE_NEWNET) != 0:
            raise OSError(ctypes.get_errno(), f"setns into {pid}")
        yield
    finally:
        LIBC.setns(home, CLONE_NEWNET)
        os.close(home)
        os.close(target)


def end(pid, name):
    peer = attr(3, cstr(name))  # IFLA_IFNAME
    return peer + (attr(19, struct.pack("I", pid)) if pid else b"")  # NET_NS_PID


def split(spec):
    pid, dev, cidr = spec.split(":")
    return int(pid), dev, cidr


def address(dev, cidr):
    ip, length = cidr.split("/")
    raw = socket.inet_aton(ip)
    body = struct.pack("BBBBI", socket.AF_INET, int(length), 0, 0, socket.if_nametoindex(dev))
    talk(RTM_NEWADDR, NLM_F_CREATE | NLM_F_EXCL, body + attr(2, raw) + attr(1, raw))


def bring_up(dev, multicast):
    change = IFF_UP | IFF_MULTICAST
    flags = IFF_UP | (IFF_MULTICAST if multicast else 0)
    talk(RTM_NEWLINK, 0, ifinfo(socket.if_nametoindex(dev), flags, change))


def cmd_lo(pid):
    with inside(pid):
        bring_up("lo", True)


def cmd_veth(a, b, multicast):
    (pid_a, dev_a, cidr_a), (pid_b, dev_b, cidr_b) = split(a), split(b)
    peer = attr(1, ifinfo() + end(pid_b, dev_b), nested=True)  # VETH_INFO_PEER
    info = attr(1, cstr("veth")) + attr(2, peer, nested=True)
    body = ifinfo() + end(pid_a, dev_a) + attr(18, info, nested=True)
    talk(RTM_NEWLINK, NLM_F_CREATE | NLM_F_EXCL, body)
    for pid, dev, cidr in ((pid_a, dev_a, cidr_a), (pid_b, dev_b, cidr_b)):
        with inside(pid):
            address(dev, cidr)
            bring_up(dev, multicast)


def cmd_alias(pid, dev, cidr):
    with inside(pid):
        address(dev, cidr)


def cmd_route(pid, gateway, dev):
    with inside(pid):
        body = struct.pack("BBBBBBBBI", socket.AF_INET, 0, 0, 0, 254, 3, 0, 1, 0)
        body += attr(5, socket.inet_aton(gateway))  # RTA_GATEWAY
        body += attr(4, struct.pack("I", socket.if_nametoindex(dev)))  # RTA_OIF
        talk(RTM_NEWROUTE, NLM_F_CREATE | NLM_F_EXCL, body)


def cmd_down(pid, dev):
    with inside(pid):
        talk(RTM_NEWLINK, 0, ifinfo(socket.if_nametoindex(dev), 0, IFF_UP))


def flags_of(name):
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
        raw = struct.pack("16sH", name.encode(), 0)
        reply = fcntl.ioctl(sock.fileno(), 0x8913, raw)  # SIOCGIFFLAGS
        return struct.unpack("16sH", reply[:18])[1]


def cmd_show(pid):
    with inside(pid):
        out = {}
        for _, name in socket.if_nameindex():
            flags = flags_of(name)
            out[name] = {"up": bool(flags & IFF_UP), "multicast": bool(flags & IFF_MULTICAST)}
        print(json.dumps(out))


def cmd_reach(src, dst, ip):
    """Can `src` send one datagram to `ip` and have it arrive inside `dst`?"""
    heard = threading.Event()
    ready = threading.Event()
    port = []

    def serve():
        with inside(dst), socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.bind((ip, 0))
            sock.settimeout(2)
            port.append(sock.getsockname()[1])
            ready.set()
            try:
                sock.recvfrom(16)
                heard.set()
            except OSError:
                pass

    listener = threading.Thread(target=serve)
    listener.start()
    ready.wait(3)
    if port:
        with inside(src), socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.settimeout(1)
            with contextlib.suppress(OSError):
                sock.sendto(b"hello", (ip, port[0]))
    listener.join()
    return 0 if heard.is_set() else 1


def main(argv):
    verb, rest = argv[1], argv[2:]
    if verb == "lo":
        cmd_lo(int(rest[0]))
    elif verb == "veth":
        cmd_veth(rest[0], rest[1], "--multicast" in rest)
    elif verb == "alias":
        cmd_alias(int(rest[0]), rest[1], rest[2])
    elif verb == "route":
        cmd_route(int(rest[0]), rest[1], rest[2])
    elif verb == "down":
        cmd_down(int(rest[0]), rest[1])
    elif verb == "show":
        cmd_show(int(rest[0]))
    elif verb == "reach":
        return cmd_reach(int(rest[0]), int(rest[1]), rest[2])
    else:
        raise SystemExit(__doc__)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
