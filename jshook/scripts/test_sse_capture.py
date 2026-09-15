"""Offline regressions for research SSE framing."""

import json
import unittest
from unittest.mock import Mock

from sse_capture import iter_sse_payloads


class SSECaptureTests(unittest.TestCase):
    def payloads(self, lines):
        return list(iter_sse_payloads(Mock(iter_lines=lambda: iter(lines))))

    def test_multiline_json_is_one_event(self):
        payloads = self.payloads([
            b'event: message', b'data: {"message":',
            b'data: {"content": "hello"}}', b'', b'data: [DONE]', b'',
        ])
        self.assertEqual(len(payloads), 2)
        self.assertEqual(json.loads(payloads[0]), {"message": {"content": "hello"}})
        self.assertEqual(payloads[1], "[DONE]")

    def test_comment_and_metadata_only_events_have_no_payload(self):
        self.assertEqual(self.payloads([b': keepalive', b'', b'event: message', b'id: 1', b'']), [])

    def test_empty_data_fields_and_significant_whitespace_are_preserved(self):
        self.assertEqual(self.payloads([b'data:  first ', b'data', b'data:\tlast\t', b'']), [" first \n\n\tlast\t"])
        self.assertEqual(self.payloads([b'data:', b'']), [""])

    def test_utf8_bom_and_invalid_bytes_follow_sse_decoding(self):
        self.assertEqual(self.payloads([b'\xef\xbb\xbfdata: hello\xff', b'']), ["hello\ufffd"])

    def test_decoded_lines_and_incomplete_final_event(self):
        self.assertEqual(self.payloads(['data: "v1"', '', 'data: incomplete']), ['"v1"'])


if __name__ == "__main__":
    unittest.main()
