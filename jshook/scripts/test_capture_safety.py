"""Offline tests for research capture and credential boundaries."""

import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

from capture_safety import download_image, require_access_token, write_private_capture


class CaptureSafetyTests(unittest.TestCase):
    def test_missing_token_fails_before_network(self):
        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaises(RuntimeError):
                require_access_token()

    def test_capture_is_private_and_cannot_overwrite_fixture(self):
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / "capture.json"
            write_private_capture(destination, b'{"token":"local-only"}')
            self.assertEqual(destination.stat().st_mode & 0o777, 0o600)
            with self.assertRaises(FileExistsError):
                write_private_capture(destination, b"replacement")
            self.assertIn(b"local-only", destination.read_bytes())

    def test_cross_origin_download_does_not_use_authenticated_session(self):
        session, public_get = Mock(), Mock()
        public_get.return_value = Mock(status_code=200, headers={"content-type": "image/png"})
        download_image(session, public_get, "https://cdn.example/image?sig=example", "test-agent")
        session.get.assert_not_called()
        self.assertEqual(public_get.call_args.kwargs["headers"], {"User-Agent": "test-agent"})
        self.assertFalse(public_get.call_args.kwargs["allow_redirects"])

    def test_only_exact_upstream_origin_receives_session(self):
        for url in ("https://chatgpt.com:444/image", "https://chatgpt.com.example/image"):
            with self.subTest(url=url):
                session, public_get = Mock(), Mock()
                public_get.return_value = Mock(status_code=200, headers={"content-type": "image/png"})
                download_image(session, public_get, url, "test-agent")
                session.get.assert_not_called()
        session, public_get = Mock(), Mock()
        session.get.return_value = Mock(status_code=200, headers={"content-type": "image/png"})
        download_image(session, public_get, "https://chatgpt.com/backend-api/estuary/content", "test-agent")
        public_get.assert_not_called()
        self.assertFalse(session.get.call_args.kwargs["allow_redirects"])

    def test_redirect_error_and_nonimage_are_not_saved_as_images(self):
        for status, content_type in ((302, "image/png"), (403, "text/html"), (200, "text/html")):
            with self.subTest(status=status, content_type=content_type):
                session, public_get = Mock(), Mock()
                response = Mock(status_code=status, headers={"content-type": content_type})
                public_get.return_value = response
                with self.assertRaises(RuntimeError):
                    download_image(session, public_get, "https://cdn.example/image", "test-agent")
                response.close.assert_called_once()

    def test_download_rejects_insecure_or_credentialed_url(self):
        for url in ("http://chatgpt.com/image", "https://user:pass@cdn.example/image"):
            with self.subTest(url=url), self.assertRaises(RuntimeError):
                download_image(Mock(), Mock(), url, "test-agent")


if __name__ == "__main__":
    unittest.main()
