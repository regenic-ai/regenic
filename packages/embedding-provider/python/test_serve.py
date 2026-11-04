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

    def embed_with_counts(self, texts, mode):
        return self.count(texts, mode), self.embed(texts, mode)


class ProtocolTests(unittest.TestCase):
    def test_health_is_descriptor_only_and_rejects_browser_origins(self):
        server = BoundedHTTPServer(("127.0.0.1", 0), handler_for(FakeEncoder()))
        thread = threading.Thread(target=server.serve_forever)
        thread.start()
        try:
            for path, headers, status in (
                ("/health", {}, 200),
                ("/health", {"Origin": "https://example.com"}, 403),
                ("/missing", {}, 404),
            ):
                connection = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=5)
                connection.request("GET", path, headers=headers)
                response = connection.getresponse()
                self.assertEqual(response.status, status)
                value = json.loads(response.read())
                if status == 200:
                    self.assertEqual(value, {"status": "ready", "descriptor": DESCRIPTOR})
                connection.close()
        finally:
            server.shutdown()
            thread.join()
            server.server_close()

    def test_queries_precede_queued_documents_and_queue_is_bounded(self):
        started = threading.Event()
        release = threading.Event()
        order = []

        class Encoder(FakeEncoder):
            def embed_with_counts(self, texts, mode):
                if texts == ["first"]:
                    started.set()
                    if not release.wait(5):
                        raise RuntimeError("test_timeout")
                order.append(texts[0])
                return super().embed_with_counts(texts, mode)

        encoder = PriorityEncoder(Encoder(), max_pending=2, reserved_queries=1)
        threads = [threading.Thread(target=encoder.embed_with_counts, args=(texts, mode)) for texts, mode in (
            (["first"], "document"), (["background"], "document"), (["interactive"], "query"),
        )]
        threads[0].start()
        self.assertTrue(started.wait(5))
        threads[1].start()
        with encoder.condition:
            self.assertTrue(encoder.condition.wait_for(
                lambda: encoder.waiting_documents == 1, timeout=5,
            ))
        threads[2].start()
        try:
            with encoder.condition:
                self.assertTrue(encoder.condition.wait_for(lambda: encoder.pending == 2, timeout=5))
            with self.assertRaises(InputError) as rejected:
                encoder.embed_with_counts(["excess"], "query")
            self.assertEqual(rejected.exception.status, 429)
        finally:
            release.set()
            for thread in threads:
                thread.join(5)
        self.assertEqual(order, ["first", "interactive", "background"])
        self.assertFalse(any(thread.is_alive() for thread in threads))

    def test_query_burst_is_bounded_when_documents_are_waiting(self):
        started = threading.Event()
        release = threading.Event()
        order = []

        class Encoder(FakeEncoder):
            def embed(self, texts, mode):
                if texts == ["active"]:
                    started.set()
                    if not release.wait(5):
                        raise RuntimeError("test_timeout")
                order.append(mode)
                return super().embed(texts, mode)

        encoder = PriorityEncoder(
            Encoder(), max_pending=5, reserved_queries=1, max_query_burst=2,
        )
        work = [
            (["active"], "document"),
            (["background"], "document"),
            (["query-1"], "query"),
            (["query-2"], "query"),
            (["query-3"], "query"),
        ]
        threads = [
            threading.Thread(target=encoder.embed, args=item)
            for item in work
        ]
        threads[0].start()
        self.assertTrue(started.wait(5))
        for thread in threads[1:]:
            thread.start()
        try:
            with encoder.condition:
                self.assertTrue(encoder.condition.wait_for(
                    lambda: encoder.pending == 4, timeout=5,
                ))
        finally:
            release.set()
            for thread in threads:
                thread.join(5)
        self.assertEqual(order, ["document", "query", "query", "document", "query"])
        self.assertFalse(any(thread.is_alive() for thread in threads))

    def test_same_priority_requests_are_fifo(self):
        started = threading.Event()
        release = threading.Event()
        order = []

        class Encoder(FakeEncoder):
            def embed(self, texts, mode):
                if texts == ["active"]:
                    started.set()
                    if not release.wait(5):
                        raise RuntimeError("test_timeout")
                order.append(texts[0])
                return super().embed(texts, mode)

        encoder = PriorityEncoder(Encoder())
        active = threading.Thread(target=encoder.embed, args=(["active"], "document"))
        active.start()
        self.assertTrue(started.wait(5))
        queued = []
        for index in range(3):
            thread = threading.Thread(
                target=encoder.embed, args=([f"document-{index}"], "document"),
            )
            queued.append(thread)
            thread.start()
            with encoder.condition:
                self.assertTrue(encoder.condition.wait_for(
                    lambda: encoder.waiting_documents == index + 1, timeout=5,
                ))
        release.set()
        active.join(5)
        for thread in queued:
            thread.join(5)
        self.assertEqual(order, [
            "active", "document-0", "document-1", "document-2",
        ])
        self.assertFalse(active.is_alive() or any(thread.is_alive() for thread in queued))

    def test_query_preempts_a_document_batch_between_forwards(self):
        started = threading.Event()
        release = threading.Event()
        order = []

        class Encoder(FakeEncoder):
            def embed_with_counts(self, texts, mode):
                order.append((mode, list(texts)))
                if texts == ["document-0"]:
                    started.set()
                    if not release.wait(5):
                        raise RuntimeError("test_timeout")
                return (
                    [len(text) + 5 for text in texts],
                    [[float(index), 0.0] for index, _text in enumerate(texts)],
                )

        encoder = PriorityEncoder(
            Encoder(), max_pending=2, reserved_queries=1, max_document_batch=1,
        )
        document_result = []
        background_result = []
        query_result = []
        document = threading.Thread(target=lambda: document_result.append(
            encoder.embed_with_counts(
                ["document-0", "document-1", "document-2"], "document",
            ),
        ))
        query = threading.Thread(target=lambda: query_result.append(
            encoder.embed_with_counts(["interactive"], "query"),
        ))
        background = threading.Thread(target=lambda: background_result.append(
            encoder.embed_with_counts(["background"], "document"),
        ))
        document.start()
        self.assertTrue(started.wait(5))
        background.start()
        with encoder.condition:
            self.assertTrue(encoder.condition.wait_for(
                lambda: encoder.waiting_documents == 1, timeout=5,
            ))
        query.start()
        try:
            with encoder.condition:
                self.assertTrue(encoder.condition.wait_for(
                    lambda: encoder.waiting_queries == 1, timeout=5,
                ))
        finally:
            release.set()
            document.join(5)
            background.join(5)
            query.join(5)
        self.assertEqual(order, [
            ("document", ["document-0"]),
            ("query", ["interactive"]),
            ("document", ["background"]),
            ("document", ["document-1"]),
            ("document", ["document-2"]),
        ])
        self.assertEqual(document_result[0][0], [15, 15, 15])
        self.assertEqual(len(document_result[0][1]), 3)
        self.assertEqual(background_result[0][0], [15])
        self.assertEqual(query_result[0][0], [16])
        self.assertFalse(document.is_alive() or background.is_alive() or query.is_alive())

    def test_query_batches_stay_atomic_and_document_failures_return_no_partial_result(self):
        calls = []

        class Encoder(FakeEncoder):
            def embed(self, texts, mode):
                calls.append((mode, list(texts)))
                if texts == ["document-1"]:
                    raise RuntimeError("test_failure")
                return super().embed(texts, mode)

        encoder = PriorityEncoder(Encoder(), max_document_batch=1)
        self.assertEqual(len(encoder.embed(["query-0", "query-1"], "query")), 2)
        with self.assertRaisesRegex(RuntimeError, "test_failure"):
            encoder.embed(["document-0", "document-1", "document-2"], "document")
        self.assertEqual(calls, [
            ("query", ["query-0", "query-1"]),
            ("document", ["document-0"]),
            ("document", ["document-1"]),
        ])

    def test_token_counts_do_not_wait_on_the_inference_lock(self):
        started = threading.Event()
        release = threading.Event()

        class Encoder(FakeEncoder):
            def embed(self, texts, mode):
                started.set()
                if not release.wait(5):
                    raise RuntimeError("test_timeout")
                return super().embed(texts, mode)

        encoder = PriorityEncoder(Encoder())
        thread = threading.Thread(target=encoder.embed, args=(["active"], "document"))
        thread.start()
        self.assertTrue(started.wait(5))
        try:
            self.assertTrue(encoder.busy)
            self.assertEqual(encoder.count(["hello"], "document"), [10])
            self.assertEqual(encoder.pending, 0)
        finally:
            release.set()
            thread.join(5)
        self.assertFalse(thread.is_alive())

    def test_queue_timeout_and_inference_failure_release_the_slot(self):
        encoder = PriorityEncoder(FakeEncoder(), wait_seconds=0)
        encoder.busy = True
        with self.assertRaises(InputError) as failed:
            encoder.embed(["timeout"], "query")
        self.assertEqual(failed.exception.status, 503)
        self.assertEqual(encoder.pending, 0)
        self.assertEqual(encoder.waiting_queries, 0)
        self.assertEqual(encoder.waiting_documents, 0)
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
                if path == "/embed":
                    self.assertEqual(value["counts"], [14])
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
        self.assertGreaterEqual(BoundedHTTPServer.request_queue_size, 32)
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
