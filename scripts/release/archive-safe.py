#!/usr/bin/env python3
"""Inspect every member before extracting an immutable release ZIP or tar.

No links, devices, traversal, duplicate paths, or writes into a populated tree.
This is shared by artifact transport and the artifact qualification consumers.
"""
import pathlib
import shutil
import stat
import sys
import tarfile
import zipfile

MAX_FILES = 100_000
MAX_BYTES = 8 * 1024 * 1024 * 1024


def member_path(name):
    if not name or "\\" in name or ":" in name or any(ord(c) < 32 for c in name):
        raise ValueError("Unsafe archive member name")
    path = pathlib.PurePosixPath(name)
    if path.is_absolute() or ".." in path.parts:
        raise ValueError("Archive path traversal")
    return path


def inventory(entries):
    seen, total = {}, 0
    if len(entries) > MAX_FILES:
        raise ValueError("Archive has too many members")
    for name, size, directory, _ in entries:
        path = member_path(name)
        if path == pathlib.PurePosixPath(".") and directory:
            continue
        if str(path) in seen:
            raise ValueError("Duplicate archive member")
        if size < 0:
            raise ValueError("Invalid member size")
        total += size
        if total > MAX_BYTES:
            raise ValueError("Archive exceeds extraction limit")
        seen[str(path)] = directory
    for path in seen:
        for parent in pathlib.PurePosixPath(path).parents:
            if str(parent) in seen and not seen[str(parent)]:
                raise ValueError("Archive file conflicts with a directory")


def destination_root(destination):
    root = pathlib.Path(destination)
    if root.is_symlink() or (root.exists() and (not root.is_dir() or any(root.iterdir()))):
        raise ValueError("Extraction destination must be an empty real directory")
    root.mkdir(parents=True, exist_ok=True)
    return root


def write_member(root, name, source, size, executable=False):
    path = root / member_path(name)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("xb") as output:
        shutil.copyfileobj(source, output)
    if path.stat().st_size != size:
        raise ValueError("Extracted member length differs")
    path.chmod(0o755 if executable else 0o644)


def extract_zip(archive, destination):
    with zipfile.ZipFile(archive) as source:
        entries = []
        for member in source.infolist():
            mode = member.external_attr >> 16
            kind = stat.S_IFMT(mode)
            if kind not in (0, stat.S_IFREG, stat.S_IFDIR) or member.flag_bits & 1:
                raise ValueError("ZIP links, special files and encryption are forbidden")
            if kind == stat.S_IFDIR and not member.is_dir():
                raise ValueError("ZIP directory type mismatch")
            entries.append((member.filename, member.file_size, member.is_dir(), member))
        inventory(entries)
        root = destination_root(destination)
        for name, size, directory, member in entries:
            if directory:
                (root / member_path(name)).mkdir(parents=True, exist_ok=True)
            else:
                with source.open(member) as stream:
                    write_member(root, name, stream, size)


def extract_tar(archive, destination):
    with tarfile.open(archive, "r:gz") as source:
        entries = []
        for member in source.getmembers():
            if not (member.isfile() or member.isdir()) or member.issparse():
                raise ValueError("Tar links, sparse and special files are forbidden")
            entries.append((member.name, member.size, member.isdir(), member))
        inventory(entries)
        root = destination_root(destination)
        for name, size, directory, member in entries:
            if directory:
                (root / member_path(name)).mkdir(parents=True, exist_ok=True)
            else:
                with source.extractfile(member) as stream:
                    write_member(root, name, stream, size, bool(member.mode & 0o111))


if __name__ == "__main__":
    if len(sys.argv) != 4 or sys.argv[1] not in ("zip", "tar"):
        raise SystemExit("usage: archive-safe.py zip|tar ARCHIVE EMPTY_DESTINATION")
    try:
        (extract_zip if sys.argv[1] == "zip" else extract_tar)(sys.argv[2], sys.argv[3])
    except (ValueError, OSError, tarfile.TarError, zipfile.BadZipFile) as error:
        raise SystemExit(f"archive-safe: {error}") from error
