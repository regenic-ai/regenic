import http.client
import json
import threading
import unittest
from http.server import HTTPServer
from serve import DESCRIPTOR, InputError, handler_for, validate_request


class FakeEncoder:
    def count(self, texts, mode):
        return [len(text) + 5 for text in texts]

    def embed(self, texts, mode):
        return [[1.0] + [0.0] * 767 for text in texts]


class ProtocolTests(unittest.TestCase):
    def test_validation(self):
        with self.assertRaises(InputError):
            validate_request({"descriptor": {}, "mode": "query", "texts": ["secret"]})
        for texts in ([], [""] * 33, ["x" * 262145]):
            with self.assertRaises(InputError):
                validate_request({"descriptor": DESCRIPTOR, "mode": "document", "texts": texts})

    def test_http_protocol_and_origin_boundary(self):
        server = HTTPServer(("127.0.0.1", 0), handler_for(FakeEncoder()))
        thread = threading.Thread(target=server.serve_forever)
        thread.start()
        try:
            for path, expected in (("/tokens", "counts"), ("/embed", "vectors")):
                connection = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=5)
                connection.request("POST", path, json.dumps({
                    "descriptor": DESCRIPTOR, "mode": "document", "texts": ["synthetic"],
                }), {"Content-Type": "application/json"})
                response = connection.getresponse()
                self.assertEqual(response.status, 200)
                value = json.loads(response.read())
                self.assertEqual(value["descriptor"], DESCRIPTOR)
                self.assertEqual(len(value[expected]), 1)
                self.assertNotIn("synthetic", json.dumps(value))
                connection.close()
            connection = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=5)
            connection.request("POST", "/embed", "{}", {"Origin": "https://example.com"})
            self.assertEqual(connection.getresponse().status, 403)
            connection.close()
        finally:
            server.shutdown()
            thread.join()
            server.server_close()


if __name__ == "__main__":
    unittest.main()
