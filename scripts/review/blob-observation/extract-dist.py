import hashlib
import pathlib
import tarfile
import sys

artifact = pathlib.Path(sys.argv[1])
source = pathlib.Path(sys.argv[2]).resolve()
assert (artifact / "source-commit.txt").read_text().strip() == "b3f30460475f6aaefa089cfaf4855f6dc82b8bff"
expected = "db7460f849157a6fac87c76f4267fea0948729d9a088bd191217799b89da362c"
assert (artifact / "source-and-dist.sha256").read_text().split()[0] == expected
archive = artifact / "source-and-dist.tar.gz"
assert hashlib.sha256(archive.read_bytes()).hexdigest() == expected
prefix = "apps/pages/dist/"
count = total = 0
with tarfile.open(archive, "r:gz") as bundle:
    for entry in bundle:
        if entry.name == prefix.rstrip("/") or entry.name.startswith(prefix):
            parts = pathlib.PurePosixPath(entry.name)
            assert not parts.is_absolute() and ".." not in parts.parts
            assert entry.isdir() or entry.isfile()
            destination = source.joinpath(*parts.parts)
            assert destination.is_relative_to(source / "apps/pages/dist")
            count += 1
            total += entry.size
            assert count <= 50000 and total <= 300 * 1024 * 1024
            if entry.isdir():
                destination.mkdir(parents=True, exist_ok=True)
            else:
                destination.parent.mkdir(parents=True, exist_ok=True)
                with bundle.extractfile(entry) as incoming, destination.open("xb") as outgoing:
                    outgoing.write(incoming.read())
assert count > 0
assert (source / "apps/pages/dist/assets/main-9mBGH37t.js").is_file()
print("Verified b3 source receipt, archive checksum and extracted only production dist")
