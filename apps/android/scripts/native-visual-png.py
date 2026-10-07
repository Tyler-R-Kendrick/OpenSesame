"""Bounded PNG verification for actual native screenshot artifacts (not a rendering oracle)."""
import struct
import zlib


def dimensions(data):
    if not 45 <= len(data) <= 24 * 1024 * 1024 or data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("Invalid screenshot PNG")
    offset, header, compressed, ended = 8, None, bytearray(), False
    idat_ended, palette, chunks = False, False, 0
    while offset < len(data):
        chunks += 1
        if chunks > 4096:
            raise ValueError("PNG chunk bound exceeded")
        if offset + 12 > len(data):
            raise ValueError("Truncated PNG chunk")
        length, kind = struct.unpack(">I4s", data[offset:offset + 8])
        if not kind.isalpha() or kind[2] & 32:
            raise ValueError("Invalid PNG chunk identity")
        end = offset + 12 + length
        if end > len(data):
            raise ValueError("Truncated PNG payload")
        payload = data[offset + 8:end - 4]
        if zlib.crc32(kind + payload) != struct.unpack(">I", data[end - 4:end])[0]:
            raise ValueError("Invalid PNG checksum")
        if header is None and kind != b"IHDR":
            raise ValueError("PNG header must be first")
        if kind == b"IHDR":
            if header is not None or length != 13:
                raise ValueError("Duplicate or invalid PNG header")
            header = struct.unpack(">IIBBBBB", payload)
        elif kind == b"IDAT":
            if idat_ended or ended:
                raise ValueError("Non-contiguous PNG image data")
            compressed.extend(payload)
        elif kind == b"IEND":
            if length or not compressed or end != len(data):
                raise ValueError("Invalid PNG end")
            ended = True
        elif kind == b"PLTE":
            if palette or compressed or length == 0 or length > 768 or length % 3:
                raise ValueError("Invalid PNG palette")
            palette = True
        elif not kind[0] & 32:
            raise ValueError("Unsupported PNG critical chunk")
        if compressed and kind not in (b"IDAT", b"IEND"):
            idat_ended = True
        offset = end
    if not ended or header is None:
        raise ValueError("Incomplete PNG")
    width, height, depth, color, compression, filtering, interlace = header
    if not 1 <= width <= 4096 or not 1 <= height <= 4096 or depth != 8 or color not in (2, 6):
        raise ValueError("Unsupported screenshot dimensions or color")
    if compression or filtering or interlace:
        raise ValueError("Unsupported PNG encoding")
    stride = width * (3 if color == 2 else 4) + 1
    expected = height * stride
    if expected > 64 * 1024 * 1024:
        raise ValueError("Screenshot decompression bound exceeded")
    decoder = zlib.decompressobj()
    raw = decoder.decompress(compressed, expected + 1)
    if len(raw) != expected or not decoder.eof or decoder.unconsumed_tail or decoder.unused_data:
        raise ValueError("Invalid or oversized PNG scanlines")
    if any(raw[index] > 4 for index in range(0, len(raw), stride)):
        raise ValueError("Invalid PNG scanline filter")
    return width, height
