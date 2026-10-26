"""Regression tests for source drift and absent unsupported cryptography."""
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent


class SourceSubsetTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="opensesame-crypto-verify-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.subset = self.root / "third_party" / "x-crypto"
        shutil.copytree(ROOT / "third_party" / "x-crypto", self.subset)
        shutil.copyfile(ROOT / "verify-crypto-subset.py", self.root / "verify-crypto-subset.py")
        shutil.copyfile(ROOT / "go.mod", self.root / "go.mod")
        self.manifest = json.loads((self.subset / "UPSTREAM.json").read_text())
        self.source = self.subset / "chacha20" / "chacha_generic.go"

    def run_verifier(self, *args):
        return subprocess.run(
            ["python3", str(self.root / "verify-crypto-subset.py"), *args],
            capture_output=True, text=True, timeout=10, check=False,
        )

    def assert_rejected(self):
        result = self.run_verifier()
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("verification failed", result.stderr)

    def test_unchanged_source_passes(self):
        result = self.run_verifier()
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_modified_or_missing_source_fails(self):
        self.source.write_text(self.source.read_text() + "\n// changed\n")
        self.assert_rejected()
        self.source.unlink()
        self.assert_rejected()

    def test_unsupported_package_and_symlink_fail(self):
        unsupported = self.subset / "openpgp"
        unsupported.mkdir()
        (unsupported / "packet.go").write_text("package openpgp\n")
        self.assert_rejected()
        shutil.rmtree(unsupported)
        self.source.unlink()
        self.source.symlink_to(ROOT / "third_party" / "x-crypto" / "chacha20" / "chacha_generic.go")
        self.assert_rejected()

    def test_version_mismatch_fails(self):
        project = self.root / "go.mod"
        project.write_text(project.read_text().replace(self.manifest["version"], "v0.1.0"))
        self.assert_rejected()

    def test_every_included_package_requires_advisory_analysis(self):
        packages = {
            self.manifest["module"] + "/" + str(Path(name).parent)
            for name in self.manifest["files"] if name.endswith(".go")
        }
        imports = self.root / "imports.txt"
        imports.write_text("\n".join(packages))
        self.assertEqual(self.run_verifier("--imports", str(imports)).returncode, 0)
        imports.write_text("\n".join(packages - {"golang.org/x/crypto/cryptobyte/asn1"}))
        result = self.run_verifier("--imports", str(imports))
        self.assertEqual(result.returncode, 1)
        self.assertIn("omitted from advisory analysis", result.stderr)

    def test_rehashing_modified_source_cannot_pass_upstream_comparison(self):
        upstream = self.root / "canonical"
        shutil.copytree(self.subset, upstream)
        self.source.write_text(self.source.read_text() + "\n// changed\n")
        name = self.source.relative_to(self.subset).as_posix()
        self.manifest["files"][name] = hashlib.sha256(self.source.read_bytes()).hexdigest()
        (self.subset / "UPSTREAM.json").write_text(json.dumps(self.manifest))
        metadata = self.root / "upstream.json"
        metadata.write_text(json.dumps({
            "Path": self.manifest["module"], "Version": self.manifest["version"],
            "Sum": self.manifest["sum"], "Origin": {"Hash": self.manifest["commit"]},
            "Dir": str(upstream),
        }))
        result = self.run_verifier("--upstream-metadata", str(metadata))
        self.assertEqual(result.returncode, 1)
        self.assertIn("differs from canonical upstream", result.stderr)


if __name__ == "__main__":
    unittest.main()
