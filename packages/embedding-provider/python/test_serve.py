import http.client
import json
import threading
import unittest
from serve import BoundedHTTPServer, DESCRIPTOR, InputError, PriorityEncoder, handler_for, validate_request


class FakeEncoder:
    def count(self, texts, mode):
        return [len(text) + 5 for text in texts]

    def embed(self, texts, mode):
        return [[1.0] + [0.0] * 767 for text in texts]


class ProtocolTests(unittest.TestCase):
    def test_queries_precede_queued_documents_and_queue_is_bounded(self):
        started = threading.Event()
        release = threading.Event()
        order = []

        class Encoder(FakeEncoder):
            def embed(self, texts, mode):
                if texts == ["first"]:
                    started.set()
                    if not release.wait(5):
                        raise RuntimeError("test_timeout")
                order.append(texts[0])
                return super().embed(texts, mode)

        encoder = PriorityEncoder(Encoder(), max_pending=2)
        threads = [threading.Thread(target=encoder.embed, args=(texts, mode)) for texts, mode in (
            (["first"], "document"), (["background"], "document"), (["interactive"], "query"),
        )]
        threads[0].start()
        self.assertTrue(started.wait(5))
        threads[1].start()
        threads[2].start()
        try:
            with encoder.condition:
                self.assertTrue(encoder.condition.wait_for(lambda: encoder.pending == 2, timeout=5))
            with self.assertRaises(InputError) as rejected:
                encoder.embed(["excess"], "query")
            self.assertEqual(rejected.exception.status, 429)
        finally:
            release.set()
            for thread in threads:
                thread.join(5)
        self.assertEqual(order, ["first", "interactive", "background"])
        self.assertFalse(any(thread.is_alive() for thread in threads))

    def test_queue_timeout_and_inference_failure_release_the_slot(self):
        encoder = PriorityEncoder(FakeEncoder(), wait_seconds=0)
        encoder.busy = True
        with self.assertRaises(InputError) as failed:
            encoder.embed(["timeout"], "query")
        self.assertEqual(failed.exception.status, 503)
        self.assertEqual(encoder.pending, 0)
        self.assertEqual(encoder.waiting_queries, 0)
        encoder.busy = False
        self.assertEqual(len(encoder.embed(["ready"], "query")), 1)

        class FailOnce(FakeEncoder):
            failed = False

            def embed(self, texts, mode):
                if not self.failed:
                    self.failed = True
                    raise RuntimeError("test_failure")
                return super().embed(texts, mode)

        failing = PriorityEncoder(FailOnce())
        with self.assertRaisesRegex(RuntimeError, "test_failure"):
            failing.embed(["failure"], "document")
        self.assertFalse(failing.busy)
        self.assertEqual(len(failing.embed(["ready"], "query")), 1)
    def test_validation(self):
        with self.assertRaises(InputError):
            validate_request({"descriptor": {}, "mode": "query", "texts": ["secret"]})
        for texts in ([], [""] * 33, ["x" * 262145]):
            with self.assertRaises(InputError):
                validate_request({"descriptor": DESCRIPTOR, "mode": "document", "texts": texts})

    def test_http_protocol_and_origin_boundary(self):
        server = BoundedHTTPServer(("127.0.0.1", 0), handler_for(FakeEncoder()))
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

    def test_http_capacity_rejects_explicitly_without_starting_another_thread(self):
        server = BoundedHTTPServer.__new__(BoundedHTTPServer)
        server.slots = threading.BoundedSemaphore(0)
        written = []
        closed = []

        class Socket:
            def sendall(self, value):
                written.append(value)

        server.shutdown_request = lambda request: closed.append(request)
        request = Socket()
        server.process_request(request, ("127.0.0.1", 12345))
        self.assertTrue(written[0].startswith(b"HTTP/1.0 503"))
        self.assertEqual(closed, [request])


if __name__ == "__main__":
    unittest.main()
