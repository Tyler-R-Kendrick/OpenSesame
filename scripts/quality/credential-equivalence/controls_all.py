#!/usr/bin/env python3
"""Pure controlled parser/filesystem suites; never a native proof/campaign result."""
import unittest

import controls
import capture_controls
import portable_controls
import collect_controls
import classification_controls
import raw_collector_controls
import registry_controls


if __name__=='__main__':
    loader = unittest.defaultTestLoader
    suite = unittest.TestSuite(loader.loadTestsFromModule(module) for module in
        (controls,capture_controls,portable_controls,collect_controls,classification_controls,raw_collector_controls,registry_controls))
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    raise SystemExit(0 if result.wasSuccessful() else 1)
