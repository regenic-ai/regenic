"""Explicitly started, loopback-only text inference. Never reads Regenic stores."""

import argparse
import json
import logging
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MODEL_ID = "google/embeddinggemma-2"
REVISION = "914f7f89142e33e77833254d9c9b90c3cef7303b"
DESCRIPTOR = {
    "model_id": MODEL_ID,
    "model_revision": REVISION,
    "tokenizer_revision": REVISION,
    "dimensions": 768,
    "max_input_tokens": 8192,
    "query_template": "task: search result | query: ",
    "document_template": "title: none | text: ",
    "normalization": "l2",
    "similarity": "cosine",
    "numeric_format": "float32",
}


class InputError(Exception):
    def __init__(self, status):
        self.status = status


def validate_request(value):
    if not isinstance(value, dict) or value.get("descriptor") != DESCRIPTOR:
        raise InputError(409)
    texts = value.get("texts")
    if value.get("mode") not in ("document", "query") or not isinstance(texts, list):
        raise InputError(400)
    if not 1 <= len(texts) <= 32 or any(
        not isinstance(text, str) or not text or len(text.encode("utf-8")) > 262144
        for text in texts
    ):
        raise InputError(400)
    return texts, value["mode"]


class TextEncoder:
    def __init__(self, device):
        from sentence_transformers import SentenceTransformer
        from transformers import AutoTokenizer

        self.tokenizer = AutoTokenizer.from_pretrained(
            MODEL_ID, revision=REVISION, trust_remote_code=False
        )
        self.model = SentenceTransformer(
            MODEL_ID,
            revision=REVISION,
            device=device,
            trust_remote_code=False,
            config_kwargs={"vision_config": None, "audio_config": None},
        )
        self.model.max_seq_length = DESCRIPTOR["max_input_tokens"]

    def count(self, texts, mode):
        prefix = DESCRIPTOR[f"{mode}_template"]
        encoded = self.tokenizer(
            [prefix + text for text in texts],
            add_special_tokens=True,
            truncation=False,
            padding=False,
        )
        return [len(tokens) for tokens in encoded["input_ids"]]

    def embed(self, texts, mode):
        import numpy as np

        counts = self.count(texts, mode)
        if any(count > DESCRIPTOR["max_input_tokens"] for count in counts):
            raise InputError(413)
        prefix = DESCRIPTOR[f"{mode}_template"]
        effective = self.model.preprocess([prefix + text for text in texts])
        if effective["attention_mask"].sum(dim=1).tolist() != counts:
            raise InputError(409)
        vectors = self.model.encode(
            texts,
            prompt_name="Document" if mode == "document" else "SearchQuery",
            normalize_embeddings=True,
            convert_to_numpy=True,
            show_progress_bar=False,
        ).astype("float32")
        if vectors.shape != (len(texts), DESCRIPTOR["dimensions"]) or not np.isfinite(vectors).all():
            raise RuntimeError("invalid_embedding_output")
        norms = np.linalg.norm(vectors, axis=1, keepdims=True)
        if not np.isfinite(norms).all() or (norms <= 0).any():
            raise RuntimeError("invalid_embedding_output")
        # BF16 normalization can drift; normalize again after the float32 cast.
        vectors /= norms
        return vectors.tolist()


class PriorityEncoder:
    def __init__(self, encoder, max_pending=16, wait_seconds=30):
        self.encoder = encoder
        self.max_pending = max_pending
        self.wait_seconds = wait_seconds
        self.condition = threading.Condition()
        self.busy = False
        self.pending = 0
        self.waiting_queries = 0

    def call(self, method, texts, mode):
        with self.condition:
            if self.pending >= self.max_pending:
                raise InputError(429)
            self.pending += 1
            self.waiting_queries += int(mode == "query")
            self.condition.notify_all()
            try:
                ready = self.condition.wait_for(
                    lambda: not self.busy and (mode == "query" or self.waiting_queries == 0),
                    timeout=self.wait_seconds,
                )
                if not ready:
                    raise InputError(503)
                self.busy = True
            finally:
                self.pending -= 1
                self.waiting_queries -= int(mode == "query")
        try:
            return getattr(self.encoder, method)(texts, mode)
        finally:
            with self.condition:
                self.busy = False
                self.condition.notify_all()

    def count(self, texts, mode):
        return self.call("count", texts, mode)

    def embed(self, texts, mode):
        return self.call("embed", texts, mode)


class BoundedHTTPServer(ThreadingHTTPServer):
    def __init__(self, address, handler):
        self.slots = threading.BoundedSemaphore(32)
        super().__init__(address, handler)

    def process_request(self, request, client_address):
        if not self.slots.acquire(blocking=False):
            try:
                request.sendall(b"HTTP/1.0 503 Service Unavailable\r\nContent-Length: 0\r\n\r\n")
            finally:
                self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except (RuntimeError, OSError):
            self.slots.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.slots.release()


def handler_for(encoder):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, _format, *args):
            pass

        def do_POST(self):
            self.connection.settimeout(10)
            if self.headers.get("Origin") is not None:
                self.reply(403, {"error": "origin_rejected"})
                return
            if self.path not in ("/tokens", "/embed"):
                self.reply(404, {"error": "not_found"})
                return
            try:
                if self.headers.get_content_type() != "application/json":
                    raise InputError(400)
                length = int(self.headers.get("Content-Length", "0"))
                if not 0 < length <= 1048576:
                    raise InputError(413)
                body = self.rfile.read(length)
                if len(body) != length:
                    raise InputError(400)
                texts, mode = validate_request(json.loads(body))
                field = "counts" if self.path == "/tokens" else "vectors"
                result = encoder.count(texts, mode) if field == "counts" else encoder.embed(texts, mode)
                self.reply(200, {"descriptor": DESCRIPTOR, field: result})
            except InputError as error:
                logging.warning("embedding_request_rejected status=%d", error.status)
                self.reply(error.status, {"error": "invalid_embedding_request"})
            except (ValueError, UnicodeError):
                self.reply(400, {"error": "invalid_json"})
            except (TimeoutError, ConnectionError):
                logging.warning("embedding_client_disconnected")
            except (RuntimeError, OSError):
                logging.error("embedding_inference_failed")
                self.reply(503, {"error": "inference_failed"})

        def reply(self, status, value):
            body = json.dumps(value, allow_nan=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    return Handler


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--device", default="cpu")
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error("port must be between 1 and 65535")
    encoder = PriorityEncoder(TextEncoder(args.device))
    server = BoundedHTTPServer(("127.0.0.1", args.port), handler_for(encoder))
    logging.warning("embedding_ready model_revision=%s port=%d", REVISION, args.port)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
