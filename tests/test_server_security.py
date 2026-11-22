"""Integration tests for Markdown Preview's localhost-only editor HTTP interface."""

import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import time
import unittest
import urllib.error
import urllib.request


ROOT = Path(__file__).resolve().parents[1]
NODE = shutil.which('node')


@unittest.skipUnless(NODE, 'Node.js is required')
class MarkdownPreviewHTTPTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory(prefix='md-preview-test-')
        cls.document = Path(cls.tmp.name) / 'sample.md'
        cls.document.write_text('# Local document\\n')
        with socket.socket() as s:
            s.bind(('127.0.0.1', 0))
            cls.port = s.getsockname()[1]
        env = dict(os.environ)
        # Do not launch Chrome during the headless integration test.
        env['PATH'] = str(Path(NODE).parent)
        cls.server = subprocess.Popen(
            [NODE, str(ROOT / 'scripts/render-preview.mjs'), str(cls.document), '--port', str(cls.port)],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=env
        )
        cls.client = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        for _ in range(45):
            if cls.server.poll() is not None:
                raise RuntimeError('Markdown Preview server exited during startup')
            try:
                if cls.call('GET', '/')[0] == 200:
                    return
            except urllib.error.URLError:
                time.sleep(0.1)
        raise RuntimeError('Markdown Preview server did not start')

    @classmethod
    def tearDownClass(cls):
        cls.server.terminate()
        try:
            cls.server.wait(timeout=3)
        except subprocess.TimeoutExpired:
            cls.server.kill()
        cls.tmp.cleanup()

    @classmethod
    def call(cls, method, path, data=None, headers=None):
        req = urllib.request.Request(
            'http://127.0.0.1:' + str(cls.port) + path,
            data=data, headers=headers or {}, method=method
        )
        try:
            with cls.client.open(req, timeout=2) as r:
                return r.status, r.read()
        except urllib.error.HTTPError as e:
            return e.code, e.read()

    def test_preview_is_accessible_locally(self):
        status, body = self.call('GET', '/')
        self.assertEqual(status, 200)
        self.assertIn(b'Local document', body)

    def test_same_origin_edit_saves_source_document(self):
        status, _ = self.call(
            'POST', '/__save?f=0', data=b'# Updated by test\\n',
            headers={'Origin': 'http://127.0.0.1:' + str(self.port)}
        )
        self.assertEqual(status, 200)
        self.assertIn('Updated by test', self.document.read_text())

    def test_untrusted_web_origin_cannot_modify_file(self):
        before = self.document.read_text()
        status, _ = self.call(
            'POST', '/__save?f=0', data=b'# Should not be saved',
            headers={'Origin': 'https://example.invalid'}
        )
        self.assertEqual(status, 403)
        self.assertEqual(self.document.read_text(), before)

    def test_cross_site_requests_are_rejected(self):
        status, _ = self.call(
            'POST', '/__open', data=b'{}',
            headers={'Sec-Fetch-Site': 'cross-site', 'Origin': 'https://example.invalid'}
        )
        self.assertEqual(status, 403)

    def test_dns_rebinding_host_is_rejected(self):
        status, _ = self.call(
            'GET', '/',
            headers={'Host': 'untrusted.example:' + str(self.port)}
        )
        self.assertEqual(status, 403)


if __name__ == '__main__':
    unittest.main()
