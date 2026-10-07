import hashlib
import importlib.util
import json
import os
import struct
import sys
import subprocess
import tempfile
import unittest
import zlib
from pathlib import Path

sys.dont_write_bytecode = True
script = Path(__file__).resolve().parents[1] / "scripts/verify-native-visual.py"
spec = importlib.util.spec_from_file_location("native_visual", script)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def chunk(kind, data):
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))


def image(raw=b"\0" + b"\x80" * 6 + b"\0" + b"\x80" * 6):
    # Genuine public PNG encoding fixture for parser controls; never a captured native screen.
    header = struct.pack(">IIBBBBB", 2, 2, 8, 2, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")


class VisualResultsTest(unittest.TestCase):
    source, application = "a" * 40, "b" * 64

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.directory = self.root / "visual"
        self.directory.mkdir()
        catalog = module.load(script.with_name("native-required-cases.json"))["androidDevice"]
        cases = [suite + "." + name for suite, names in catalog.items() for name in names]
        self.report = self.root / "admission.json"
        self.report.write_text(json.dumps({"passed": len(cases), "failed": 0, "skipped": 0, "cases": cases, "expectedPageBytes": 4096}))
        for name in module.PASSWORD:
            self.create(name)

    def create(self, name, platform="android"):
        png = image()
        metadata = {"v": 1, "platform": platform, "checkpoint": name, "sourceSha": self.source,
                    "imageSha256": hashlib.sha256(png).hexdigest(), "viewport": {"width": 2, "height": 2},
                    "density": 1, "bounds": [{"name": "asserted-state", "x": 0, "y": 0, "width": 1, "height": 1}]}
        if platform == "android":
            metadata.update(applicationSha256=self.application, pages=4096)
        (self.directory / (name + ".png")).write_bytes(png)
        (self.directory / (name + ".json")).write_text(json.dumps(metadata))

    def verify(self):
        return module.verify(self.directory, "android", self.source, self.application, [self.report], 4096)

    def change(self, **fields):
        path = self.directory / "security-empty.json"
        value = json.loads(path.read_text())
        value.update(fields)
        path.write_text(json.dumps(value))

    def test_complete_actual_metadata_and_named_admission_are_required(self):
        result = self.verify()
        self.assertEqual(len(result["checkpoints"]), 9)
        self.assertEqual(result["admission"][0]["passed"], 13)
        self.assertEqual(result["applicationBeforeDigest"], "not measured")

    def test_missing_and_foreign_checkpoint_fail_closed(self):
        (self.directory / "revoked.png").unlink()
        with self.assertRaises(ValueError): self.verify()
        self.create("revoked")
        self.create("foreign")
        with self.assertRaises(ValueError): self.verify()

    def test_duplicate_json_and_checkpoint_identity_fail_closed(self):
        path = self.directory / "security-empty.json"
        original = path.read_text()
        path.write_text(original[:-1] + ', "v": 1}')
        with self.assertRaises(ValueError): self.verify()
        path.write_text(original)
        self.change(checkpoint="revoked")
        with self.assertRaises(ValueError): self.verify()

    def test_source_apk_and_page_size_mismatch_fail_closed(self):
        for field, value in [("sourceSha", "c" * 40), ("applicationSha256", "c" * 64), ("pages", 16384)]:
            self.create("security-empty")
            self.change(**{field: value})
            with self.assertRaises(ValueError): self.verify()

    def test_secret_or_unexpected_metadata_is_rejected(self):
        self.change(password="public fixture text")
        with self.assertRaises(ValueError): self.verify()

    def test_missing_duplicate_skip_failure_and_unknown_admission_cases_fail(self):
        valid = self.report.read_text()
        for alteration in [lambda v: v.update(skipped=1), lambda v: v.update(failed=1),
                           lambda v: v["cases"].pop(), lambda v: v["cases"].append(v["cases"][0]),
                           lambda v: v["cases"].__setitem__(0, "Unregistered.case")]:
            value = json.loads(valid); alteration(value)
            self.report.write_text(json.dumps(value))
            with self.assertRaises(ValueError): self.verify()

    def test_invalid_bounds_viewport_and_nonfinite_density_are_rejected(self):
        for changes in [{"bounds": []}, {"bounds": [{"name": "asserted-state", "x": -1, "y": 0, "width": 1, "height": 1}]},
                        {"bounds": [{"name": "asserted-state", "x": 1, "y": 0, "width": 2, "height": 1}]},
                        {"viewport": {"width": 3, "height": 2}}, {"density": float("nan")}, {"density": True}]:
            self.create("security-empty"); self.change(**changes)
            with self.assertRaises(ValueError): self.verify()

    def test_png_truncation_bad_crc_and_bad_filter_fail_closed(self):
        for png in [image()[:-4], image()[:30] + b"!" + image()[31:], image(b"\5" + b"\x80" * 6 + b"\0" + b"\x80" * 6)]:
            with self.assertRaises((ValueError, zlib.error)): module.png.dimensions(png)

    def test_png_trailing_and_decompression_overflow_fail_closed(self):
        for png in [image() + b"extra", image(b"x" * 100000), image(b"\0")]:
            with self.assertRaises((ValueError, zlib.error)): module.png.dimensions(png)

    def test_image_digest_and_symlink_are_rejected(self):
        self.change(imageSha256="0" * 64)
        with self.assertRaises(ValueError): self.verify()
        self.create("security-empty")
        path = self.directory / "security-empty.png"
        data = path.read_bytes(); path.unlink()
        other = self.root / "image.png"; other.write_bytes(data); path.symlink_to(other)
        with self.assertRaises(ValueError): self.verify()

    def test_actual_exported_attachment_bytes_are_required(self):
        expected = {(hashlib.sha256(image()).hexdigest(), len(image()))}
        export = self.root / "export"; export.mkdir()
        with self.assertRaises(ValueError): module.exported([export], expected)
        (export / "opaque-exported-attachment.png").write_bytes(image())
        module.exported([export], expected)
        (export / "opaque-exported-attachment.png").write_bytes(image() + b"extra")
        with self.assertRaises(ValueError): module.exported([export], expected)

    def test_complete_apple_phases_require_named_cases_and_exported_json_and_png(self):
        for name in module.PASSWORD + module.CANARY:
            self.create(name, platform="apple")
        spec = importlib.util.spec_from_file_location("apple_cases", script.with_name("verify-apple-results.py"))
        apple = importlib.util.module_from_spec(spec); spec.loader.exec_module(apple)
        reports = []
        for index, cases in enumerate([apple.FRAMEWORK | apple.ENVELOPE | {apple.COLD}, {apple.PASSWORD}, {apple.CANARY}]):
            path = self.root / (str(index) + ".json")
            path.write_text(json.dumps({"passed": len(cases), "failed": 0, "skipped": 0, "cases": sorted(cases)}))
            reports.append(path)
        export = self.root / "export"; export.mkdir()
        for index, path in enumerate(self.directory.iterdir()):
            (export / str(index)).write_bytes(path.read_bytes())
        result = module.verify(self.directory, "apple", self.source, self.application, reports, attachments=[export])
        self.assertEqual(len(result["checkpoints"]), 11)
        self.assertEqual(sum(row["passed"] for row in result["admission"]), 28)
        self.assertEqual(result["applicationDigestScope"], "postbuild simulator application executable")
        json_file = next(path for path in export.iterdir() if path.read_bytes().startswith(b"{"))
        json_file.unlink()
        with self.assertRaises(ValueError):
            module.verify(self.directory, "apple", self.source, self.application, reports, attachments=[export])

    def test_failed_instrumentation_preserves_partial_capture_and_original_exit(self):
        # A failing tool fixture proves only EXIT-trap retention, never device or authority admission.
        binary = self.root / "bin"; binary.mkdir()
        fixture_png = self.root / "fixture.png"; fixture_png.write_bytes(image())
        adb = binary / "adb"
        adb.write_text("#!" + sys.executable + "\n" +
                       "import pathlib,sys\nargs=sys.argv[1:]\n" +
                       "if args[:3] == ['shell','getconf','PAGE_SIZE']: print('4096')\n" +
                       "elif args[:3] == ['shell','am','instrument']: sys.exit(7)\n" +
                       "elif args[0] == 'logcat': print('Public crash fixture')\n" +
                       "elif args == ['shell','dumpsys','window','policy']: print('Public keyguard fixture')\n" +
                       "elif args == ['shell','dumpsys','activity','exit-info','dev.opensesame.authenticator']: print('Public actual-command exit-info fixture')\n" +
                       "elif args[:2] == ['exec-out','run-as']:\n" +
                       " if args[-1].endswith('/security-empty.png'): sys.stdout.buffer.write(pathlib.Path(" + repr(str(fixture_png)) + ").read_bytes())\n" +
                       " else: print('cat: public missing fixture'); sys.exit(0)\n")
        adb.chmod(0o700)
        apk = self.root / "public-fixture.apk"; apk.write_bytes(b"public parser fixture, not an actual APK")
        report = self.root / "failed-attempt"
        environment = dict(os.environ, PATH=str(binary) + os.pathsep + os.environ["PATH"], OPENSESAME_NATIVE_REPORT_DIR=str(report))
        environment.pop("GITHUB_SHA", None)
        runner = script.with_name("test-android-device.sh")
        result = subprocess.run(["bash", str(runner), str(apk), str(apk), "4096"], env=environment,
                                cwd=script.parents[3], capture_output=True, timeout=10, check=False)
        self.assertEqual(result.returncode, 7)
        images = list((report / "visual").glob("*/security-empty.png"))
        self.assertEqual(len(images), 1)
        self.assertEqual(images[0].read_bytes(), image())
        self.assertEqual(len(list((report / "visual").glob("*/*.png"))), 1)
        self.assertEqual(list((report / "visual").glob("*/*.json")), [])
        diagnostics = report / "diagnostics"
        self.assertEqual((diagnostics / "crash-buffer.log").read_text(), "Public crash fixture\n")
        self.assertEqual((diagnostics / "runtime.log").read_text(), "Public crash fixture\n")
        self.assertEqual((diagnostics / "process.log").read_text(), "Public crash fixture\n")
        self.assertEqual((diagnostics / "exit-info.log").read_text(), "Public actual-command exit-info fixture\n")
        self.assertEqual((diagnostics / "window-policy.log").read_text(), "Public keyguard fixture\n")
        self.assertIn("cat: public missing fixture", (diagnostics / "fresh-owner-png.rejected.log").read_text())
        self.assertFalse((report / "verified.json").exists())
        self.assertEqual(list((report / "visual").glob("*-verified.json")), [])


if __name__ == "__main__":
    unittest.main()
