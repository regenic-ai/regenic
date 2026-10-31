"""Explicitly started, loopback-only inference. Never reads Regenic stores."""

import argparse
import base64
import binascii
import io
import json
import logging
import re
import stat
import threading
import zipfile
from contextlib import closing
from html.parser import HTMLParser
from pathlib import PurePosixPath
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


MAX_ATTACHMENT_BYTES = 16 * 1024 * 1024
MAX_EXTRACTED_BYTES = 32 * 1024 * 1024
MAX_TEXT_BYTES = 262144
MAX_MEDIA_VECTORS = 128
MAX_PIXELS = 20_000_000
PDF_LOCK = threading.Lock()
TEXT_SUFFIXES = {
    ".txt", ".md", ".markdown", ".csv", ".tsv", ".log", ".json", ".xml",
    ".yaml", ".yml", ".html", ".htm", ".rst", ".ics", ".js", ".ts", ".py",
    ".rb", ".go", ".java", ".c", ".h", ".cpp", ".rs", ".sh", ".sql",
    ".toml", ".ini", ".conf", ".css", ".svg",
    ".mjs", ".cjs", ".jsx", ".mts", ".cts", ".tsx", ".hpp", ".bash", ".zsh",
    ".properties", ".scss", ".less",
}


class HTMLText(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts = []
        self.hidden = 0

    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style"):
            self.hidden += 1
        elif tag in ("p", "div", "br", "tr", "li", "h1", "h2", "h3"):
            self.parts.append("\n")

    def handle_endtag(self, tag):
        if tag in ("script", "style"):
            self.hidden = max(0, self.hidden - 1)

    def handle_data(self, data):
        if not self.hidden:
            self.parts.append(data)


class AttachmentProcessor:
    """Bounded, in-memory extraction. Archive paths and external links are never opened."""

    def __init__(self, encoder):
        self.encoder = encoder
        self.texts = []
        self.text_bytes = 0
        self.vectors = []
        self.expanded_bytes = 0
        self.entries = 0

    def text(self, value):
        if not value.strip():
            return
        self.text_bytes += len(value.encode("utf-8")) + 2
        if self.text_bytes > MAX_TEXT_BYTES:
            raise InputError(413)
        self.texts.append(value)

    def image(self, image):
        if len(self.vectors) >= MAX_MEDIA_VECTORS or image.width * image.height > MAX_PIXELS:
            raise InputError(413)
        converted = image.convert("RGB")
        try:
            self.vectors.append(self.encoder.image(converted))
        finally:
            converted.close()

    def process(self, data, media_type="", filename="", depth=0):
        from PIL import Image, UnidentifiedImageError

        if not data:
            raise InputError(400)
        if len(data) > MAX_ATTACHMENT_BYTES or depth > 3:
            raise InputError(413)
        # Signatures take precedence over connector MIME and filename metadata.
        if data.startswith(b"%PDF"):
            self.pdf(data)
        elif data.startswith((b"PK\x03\x04", b"PK\x05\x06", b"PK\x07\x08")):
            self.archive(data, depth)
        elif len(data) >= 12 and data[4:8] == b"ftyp":
            self.video(data)
        else:
            try:
                with Image.open(io.BytesIO(data)) as image:
                    self.image(image)
                return
            except UnidentifiedImageError:
                pass
            suffix = PurePosixPath(filename).suffix.lower()
            if media_type.startswith("text/") or media_type == "application/json" or suffix in TEXT_SUFFIXES:
                text = data.decode("utf-8-sig")
            elif suffix == "" and media_type in ("", "application/octet-stream"):
                try:
                    text = data.decode("utf-8-sig")
                except UnicodeDecodeError as error:
                    raise InputError(415) from error
                if any(ord(char) < 32 and char not in "\t\r\n" for char in text):
                    raise InputError(415)
            else:
                raise InputError(415)
            if suffix in (".html", ".htm") or media_type == "text/html":
                parser = HTMLText()
                parser.feed(text)
                text = "".join(parser.parts)
            self.text(text)

    def pdf(self, data):
        import pypdfium2 as pdfium

        with PDF_LOCK, closing(pdfium.PdfDocument(data)) as document:
            if len(document) > MAX_MEDIA_VECTORS:
                raise InputError(413)
            for page in document:
                try:
                    with closing(page.get_textpage()) as textpage:
                        self.text(textpage.get_text_bounded())
                    width, height = page.get_size()
                    if width <= 0 or height <= 0:
                        raise InputError(400)
                    scale = min(1.5, 2048 / max(width, height))
                    bitmap = page.render(scale=scale)
                    try:
                        with bitmap.to_pil() as image:
                            self.image(image)
                    finally:
                        bitmap.close()
                finally:
                    page.close()

    def xml(self, archive, name):
        from defusedxml.ElementTree import fromstring
        return fromstring(archive.read(name))

    def archive(self, data, depth):
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            files = [entry for entry in archive.infolist() if not entry.is_dir()]
            names = {entry.filename for entry in files}
            if len(names) != len(files):
                raise InputError(400)
            self.entries += len(files)
            if self.entries > 512:
                raise InputError(413)
            for entry in files:
                if entry.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED):
                    raise InputError(415)
                path = PurePosixPath(entry.filename)
                if path.is_absolute() or ".." in path.parts or "\\" in entry.filename or \
                        stat.S_ISLNK(entry.external_attr >> 16) or entry.flag_bits & 1:
                    raise InputError(400)
                self.expanded_bytes += entry.file_size
                if self.expanded_bytes > MAX_EXTRACTED_BYTES or \
                        entry.file_size > MAX_ATTACHMENT_BYTES or \
                        entry.file_size > max(1, entry.compress_size) * 200:
                    raise InputError(413)
            if "word/document.xml" in names:
                for name in sorted(names):
                    if re.fullmatch(r"word/(document|header\d+|footer\d+|footnotes|endnotes)\.xml", name):
                        root = self.xml(archive, name)
                        self.text("\n".join(
                            "".join(node.itertext()) for node in root.iter()
                            if node.tag.endswith("}t")
                        ))
                self.office_images(archive, names, "word/media/")
            elif "xl/workbook.xml" in names:
                shared = []
                if "xl/sharedStrings.xml" in names:
                    shared = ["".join(node.itertext()) for node in self.xml(
                        archive, "xl/sharedStrings.xml"
                    )]
                for name in sorted(names):
                    if not re.fullmatch(r"xl/worksheets/sheet\d+\.xml", name):
                        continue
                    rows = []
                    for row in self.xml(archive, name).iter():
                        if not row.tag.endswith("}row"):
                            continue
                        cells = []
                        for cell in row:
                            values = [node.text or "" for node in cell.iter()
                                      if node.tag.endswith(("}v", "}t"))]
                            value = "".join(values)
                            if cell.get("t") == "s":
                                try:
                                    index = int(value)
                                    if index < 0:
                                        raise ValueError()
                                    value = shared[index]
                                except (ValueError, IndexError) as error:
                                    raise InputError(400) from error
                            cells.append(f"{cell.get('r', '')}: {value}")
                        rows.append("\t".join(cells))
                    self.text(name + "\n" + "\n".join(rows))
                self.office_images(archive, names, "xl/media/")
            elif "ppt/presentation.xml" in names:
                for name in sorted(names, key=lambda value: (
                    re.sub(r"\d+", "", value),
                    int(re.search(r"\d+", value).group()) if re.search(r"\d+", value) else 0,
                )):
                    if re.fullmatch(r"ppt/(slides/slide|notesSlides/notesSlide)\d+\.xml", name):
                        self.text("\n".join(node.text or "" for node in self.xml(
                            archive, name
                        ).iter() if node.tag.endswith("}t")))
                self.office_images(archive, names, "ppt/media/")
            else:
                for entry in files:
                    self.process(archive.read(entry), filename=entry.filename, depth=depth + 1)

    def office_images(self, archive, names, prefix):
        for name in sorted(names):
            if name.startswith(prefix):
                self.process(archive.read(name), filename=name)

    def video(self, data):
        import av

        with av.open(io.BytesIO(data)) as container:
            if not container.streams.video:
                raise InputError(400)
            stream = container.streams.video[0]
            if stream.duration is not None and float(stream.duration * stream.time_base) > 128:
                raise InputError(413)
            next_second = 0
            frames = 0
            pending = []

            def flush():
                if len(self.vectors) >= MAX_MEDIA_VECTORS:
                    raise InputError(413)
                self.vectors.append(self.encoder.video(pending))
                for image in pending:
                    image.close()
                pending.clear()

            try:
                for frame in container.decode(stream):
                    frames += 1
                    if frames > 60 * 128 or frame.width * frame.height > MAX_PIXELS:
                        raise InputError(413)
                    if frame.time is None:
                        raise InputError(400)
                    if frame.time >= 128:
                        raise InputError(413)
                    if frame.time >= next_second:
                        image = frame.to_image()
                        image.thumbnail((1024, 1024))
                        pending.append(image)
                        next_second = int(frame.time) + 1
                        if len(pending) == 16:
                            flush()
                if pending:
                    flush()
            finally:
                for image in pending:
                    image.close()
            if next_second == 0:
                raise InputError(400)

    def result(self):
        if not self.texts and not self.vectors:
            raise InputError(400)
        return {"text": "\n\n".join(self.texts), "vectors": self.vectors}


def validate_attachment(value):
    if not isinstance(value, dict) or value.get("descriptor") != DESCRIPTOR:
        raise InputError(409)
    encoded = value.get("bytes_base64")
    media_type = value.get("media_type", "")
    filename = value.get("source_filename", "")
    if not isinstance(encoded, str) or not isinstance(media_type, str) or \
            not isinstance(filename, str) or len(media_type) > 256 or len(filename) > 1024:
        raise InputError(400)
    try:
        data = base64.b64decode(encoded, validate=True)
    except (ValueError, binascii.Error) as error:
        raise InputError(400) from error
    if not data or len(data) > MAX_ATTACHMENT_BYTES:
        raise InputError(413)
    return data, media_type.split(";", 1)[0].strip().lower(), filename


def process_attachment(encoder, value):
    import av
    import pypdfium2 as pdfium
    from defusedxml.common import DefusedXmlException
    from PIL import Image
    from xml.etree.ElementTree import ParseError

    try:
        processor = AttachmentProcessor(encoder)
        processor.process(*validate_attachment(value))
        return processor.result()
    except (Image.DecompressionBombError, Image.DecompressionBombWarning) as error:
        raise InputError(413) from error
    except (av.FFmpegError, pdfium.PdfiumError, DefusedXmlException,
            ParseError, OSError, ValueError, zipfile.BadZipFile) as error:
        raise InputError(400) from error


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
    def __init__(self, device, precision="bfloat16"):
        from sentence_transformers import SentenceTransformer
        from transformers import AutoTokenizer

        if precision not in ("bfloat16", "float32"):
            raise ValueError("unsupported precision")
        self.precision = precision
        self.tokenizer = AutoTokenizer.from_pretrained(
            MODEL_ID, revision=REVISION, trust_remote_code=False
        )
        self.model = SentenceTransformer(
            MODEL_ID,
            revision=REVISION,
            device=device,
            trust_remote_code=False,
            config_kwargs={"audio_config": None},
            model_kwargs={"dtype": precision} if device == "cpu" else None,
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

    def image(self, image, _mode=None):
        return self.visual({"text": "<|image|>", "image": [image]})

    def video(self, frames, _mode=None):
        return self.visual({
            "text": "<|video|>",
            "video": {
                "array": frames,
                "video_metadata": {
                    "fps": 1.0,
                    "total_num_frames": len(frames),
                    "duration": float(len(frames)),
                    "frames_indices": list(range(len(frames))),
                },
            },
        })

    def visual(self, value):
        import numpy as np

        vectors = self.model.encode(
            [value],
            prompt="",
            normalize_embeddings=True,
            convert_to_numpy=True,
            show_progress_bar=False,
        ).astype("float32")
        if vectors.shape != (1, DESCRIPTOR["dimensions"]) or not np.isfinite(vectors).all():
            raise RuntimeError("invalid_embedding_output")
        norm = np.linalg.norm(vectors[0])
        if not np.isfinite(norm) or norm <= 0:
            raise RuntimeError("invalid_embedding_output")
        return (vectors[0] / norm).tolist()

    def attachment(self, value, _mode):
        return process_attachment(self, value)


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

    def attachment(self, value):
        return process_attachment(self, value)

    def image(self, image):
        return self.call("image", image, "document")

    def video(self, frames):
        return self.call("video", frames, "document")


class BoundedHTTPServer(ThreadingHTTPServer):
    def __init__(self, address, handler):
        self.slots = threading.BoundedSemaphore(32)
        self.attachment_slots = threading.BoundedSemaphore(1)
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

        def do_GET(self):
            if self.path != "/health":
                self.reply(404, {"error": "not_found"})
            elif self.headers.get("Origin") is not None:
                self.reply(403, {"error": "origin_rejected"})
            else:
                self.reply(200, {"status": "ready", "descriptor": DESCRIPTOR})

        def do_POST(self):
            self.connection.settimeout(10)
            if self.headers.get("Origin") is not None:
                self.reply(403, {"error": "origin_rejected"})
                return
            if self.path not in ("/tokens", "/embed", "/attachment"):
                self.reply(404, {"error": "not_found"})
                return
            attachment_slot = False
            try:
                if self.headers.get_content_type() != "application/json":
                    raise InputError(400)
                length = int(self.headers.get("Content-Length", "0"))
                limit = 23 * 1024 * 1024 if self.path == "/attachment" else 1048576
                if not 0 < length <= limit:
                    raise InputError(413)
                if self.path == "/attachment":
                    attachment_slot = self.server.attachment_slots.acquire(blocking=False)
                    if not attachment_slot:
                        raise InputError(503)
                body = self.rfile.read(length)
                if len(body) != length:
                    raise InputError(400)
                value = json.loads(body)
                if self.path == "/attachment":
                    validate_attachment(value)
                    self.reply(200, {"descriptor": DESCRIPTOR, **encoder.attachment(value)})
                    return
                texts, mode = validate_request(value)
                field = "counts" if self.path == "/tokens" else "vectors"
                result = encoder.count(texts, mode) if field == "counts" else encoder.embed(texts, mode)
                self.reply(200, {"descriptor": DESCRIPTOR, field: result})
            except InputError as error:
                logging.warning("embedding_request_rejected status=%d", error.status)
                self.reply(error.status, {"error": "invalid_embedding_request"})
            except (ValueError, UnicodeError, zipfile.BadZipFile):
                logging.warning("embedding_request_rejected status=400")
                self.reply(400, {"error": "invalid_json"})
            except (TimeoutError, ConnectionError):
                logging.warning("embedding_client_disconnected")
            except (RuntimeError, OSError):
                logging.error("embedding_inference_failed")
                self.reply(503, {"error": "inference_failed"})
            finally:
                if attachment_slot:
                    self.server.attachment_slots.release()

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
    parser.add_argument("--precision", choices=("bfloat16", "float32"), default="bfloat16")
    parser.add_argument("--download-only", action="store_true")
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error("port must be between 1 and 65535")
    from PIL import Image
    import warnings
    Image.MAX_IMAGE_PIXELS = MAX_PIXELS
    warnings.simplefilter("error", Image.DecompressionBombWarning)
    encoder = PriorityEncoder(TextEncoder(args.device, args.precision))
    if args.download_only:
        logging.warning(
            "embedding_download_verified model_revision=%s precision=%s",
            REVISION, args.precision
        )
        return
    server = BoundedHTTPServer(("127.0.0.1", args.port), handler_for(encoder))
    logging.warning(
        "embedding_ready model_revision=%s precision=%s port=%d",
        REVISION, args.precision, args.port
    )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
