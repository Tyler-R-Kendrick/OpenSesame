"""Actual local byte-copy/parser controls, never native execution evidence."""
from pathlib import Path
import tempfile
import unittest

from contract import Copies, LIMITS, stable_read
from capture import commands, selected


class CaptureControls(unittest.TestCase):
    def test_actual_log_parser_selects_only_owning_compiler_explicit_dependency(self):
        value = commands(b' Fresh cached libc\n Running `/p/rustc --crate-name opensesame_sealed_store '
                         b'--crate-type lib src/lib.rs --out-dir /p/deps '
                         b'--extern libc=/p/deps/liblibc-0123456789abcdef.rlib`\n')
        self.assertEqual(len(value),1)
        self.assertEqual(selected(value[0]),(Path('/p/deps/liblibc-0123456789abcdef.rlib'),Path('/p/deps')))
        self.assertIsNone(selected(['rustc','--crate-name','foreign','--crate-type','lib']))

    def test_ambiguous_relative_other_directory_or_noncanonical_artifact_refuses(self):
        start = ['rustc','--crate-name','opensesame_sealed_store','--crate-type','lib','--out-dir','/p/deps']
        for suffix in [['--extern','libc=relative.rlib'],['--extern','libc=/other/liblibc-0123456789abcdef.rlib'],
                       ['--extern','libc=/p/deps/arbitrary.rlib'],['--extern','libc=/p/deps/liblibc-0123456789abcdef.rlib',
                        '--extern','libc=/p/deps/liblibc-fedcba9876543210.rlib']]:
            with self.subTest(suffix=suffix), self.assertRaises(ValueError): selected(start+suffix)

    def test_stable_copy_retains_actual_bytes_and_refuses_directory_reuse(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root/'liblibc-0123456789abcdef.rlib'
            source.write_bytes(b'fixture-copy source bytes, not compiled')
            copies = Copies(root/'capture')
            row = copies.add('rlib',source,LIMITS['rlib'])
            self.assertEqual((copies.root/row['path']).read_bytes(),source.read_bytes())
            copies.save({'v':1,'status':'fixture-only'})
            with self.assertRaises(FileExistsError): Copies(copies.root)
            with self.assertRaises(FileExistsError): copies.save({'v':1})

    def test_duplicate_role_unbounded_input_and_symlinked_origin_refuse(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root/'source'
            source.write_bytes(b'abcdefgh')
            copies = Copies(root/'capture')
            copies.add('rlib',source,8)
            with self.assertRaises(ValueError): copies.add('rlib',source,8)
            with self.assertRaises(ValueError): stable_read(source,7)
            link = root/'link'
            link.symlink_to(source)
            with self.assertRaises(ValueError): copies.add('wrong',link,8)
            directory = root/'alias'
            directory.symlink_to(root,target_is_directory=True)
            with self.assertRaises(ValueError): copies.add('ancestor',directory/'source',8)

    def test_fresh_only_or_unterminated_text_does_not_invent_compiler_evidence(self):
        self.assertEqual(commands(b' Fresh libc v0.2.189\n'),[])
        self.assertEqual(commands(b' Running `unterminated\n'),[])
        with self.assertRaises(ValueError): selected(['rustc','--crate-name','opensesame_sealed_store',
            '--crate-type','lib','--out-dir','/deps'])
