import base64
import io
import json
import http.client
import threading
import unittest
import zipfile

from PIL import Image
from serve import (
    AttachmentProcessor, BoundedHTTPServer, DESCRIPTOR, InputError,
    MAX_ATTACHMENT_BYTES, PriorityEncoder, TextEncoder, handler_for,
)


class FakeEncoder:
    attachment = TextEncoder.attachment

    def __init__(self):
        self.images = 0

    def image(self, image, _mode=None):
        self.images += 1
        assert image.mode == "RGB"
        return [1.0] + [0.0] * 767

    def video(self, frames, _mode=None):
        assert 1 <= len(frames) <= 16
        assert all(image.width <= 1024 and image.height <= 1024 for image in frames)
        return [1.0] + [0.0] * 767


def image_bytes():
    output = io.BytesIO()
    with Image.new("RGB", (40, 30), "blue") as image:
        image.save(output, "JPEG")
    return output.getvalue()


def archive_bytes(entries):
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, value in entries.items():
            archive.writestr(name, value)
    return output.getvalue()


def pdf_bytes(text=True):
    stream = b"BT /F1 14 Tf 10 60 Td (Local PDF) Tj ET" if text else b"0 0 1 rg 0 0 80 80 re f"
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] "
        b"/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"\nendstream",
    ]
    output = bytearray(b"%PDF-1.4\n")
    offsets = []
    for index, value in enumerate(objects, 1):
        offsets.append(len(output))
        output.extend(f"{index} 0 obj\n".encode() + value + b"\nendobj\n")
    offset = len(output)
    output.extend(f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n".encode())
    for value in offsets:
        output.extend(f"{value:010d} 00000 n \n".encode())
    output.extend(
        f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{offset}\n%%EOF\n".encode()
    )
    return bytes(output)


def request(data, media_type="application/octet-stream", filename=""):
    return {
        "descriptor": DESCRIPTOR,
        "bytes_base64": base64.b64encode(data).decode(),
        "media_type": media_type,
        "source_filename": filename,
    }


def extract(data, media_type="application/octet-stream", filename=""):
    return FakeEncoder().attachment(request(data, media_type, filename), "document")


class AttachmentTests(unittest.TestCase):
    def test_signature_overrides_wrong_filename_and_mime(self):
        result = extract(image_bytes(), "image/png", "wrong.png")
        self.assertEqual(len(result["vectors"]), 1)
        self.assertEqual(result["text"], "")
        self.assertEqual(len(extract(image_bytes())["vectors"]), 1)

    def test_pdf_text_and_scanned_pages_are_both_indexable(self):
        result = extract(pdf_bytes())
        self.assertIn("Local PDF", result["text"])
        self.assertEqual(len(result["vectors"]), 1)
        result = extract(pdf_bytes(False))
        self.assertEqual(result["text"], "")
        self.assertEqual(len(result["vectors"]), 1)

    def test_docx_xlsx_pptx_extract_locally_without_resolving_external_links(self):
        docx = archive_bytes({
            "word/document.xml": '<w:document xmlns:w="urn:word"><w:p><w:r><w:t>Local notes</w:t>'
                                 '</w:r></w:p></w:document>',
            "word/media/image1.jpg": image_bytes(),
        })
        result = extract(docx)
        self.assertIn("Local notes", result["text"])
        self.assertEqual(len(result["vectors"]), 1)
        xlsx = archive_bytes({
            "xl/workbook.xml": "<workbook/>",
            "xl/sharedStrings.xml": '<sst xmlns="urn:sheet"><si><t>Revenue</t></si></sst>',
            "xl/worksheets/sheet1.xml": '<worksheet xmlns="urn:sheet"><sheetData><row>'
                '<c r="A1" t="s"><v>0</v></c><c r="B1"><v>42</v></c>'
                '<c r="C1" t="inlineStr"><is><t>Local cell</t></is></c>'
                '</row></sheetData></worksheet>',
        })
        result = extract(xlsx)
        self.assertIn("Revenue", result["text"])
        self.assertIn("42", result["text"])
        self.assertIn("Local cell", result["text"])
        pptx = archive_bytes({
            "ppt/presentation.xml": "<presentation/>",
            "ppt/slides/slide1.xml": '<a:sld xmlns:a="urn:slides"><a:t>Launch plan</a:t></a:sld>',
            "ppt/notesSlides/notesSlide1.xml": '<a:notes xmlns:a="urn:slides"><a:t>Speaker notes</a:t></a:notes>',
        })
        result = extract(pptx)
        self.assertIn("Launch plan", result["text"])
        self.assertIn("Speaker notes", result["text"])

    def test_zip_nested_text_html_and_images(self):
        data = archive_bytes({
            "notes.md": "# Local archive",
            "nested.zip": archive_bytes({"image.jpg": image_bytes()}),
            "page.html": "<p>Visible</p><script>hidden</script><style>hidden</style>",
            "code.tsx": "export const LocalComponent = 'local code'",
        })
        result = extract(data)
        self.assertIn("Local archive", result["text"])
        self.assertIn("Visible", result["text"])
        self.assertNotIn("hidden", result["text"])
        self.assertIn("LocalComponent", result["text"])
        self.assertEqual(len(result["vectors"]), 1)
        self.assertIn("extensionless text", extract(b"extensionless text")["text"])

    def test_archive_limits_traversal_encryption_and_xml_entities_fail_explicitly(self):
        cases = [
            (archive_bytes({"../outside.txt": "no"}), 400),
            (archive_bytes({"/outside.txt": "no"}), 400),
            (archive_bytes({"large.txt": "x" * 1000000}), 413),
            (archive_bytes({"word/document.xml":
                '<!DOCTYPE a [<!ENTITY x "expansion">]><a>&x;</a>'}), 400),
            (archive_bytes({"unknown.bin": b"\x00\xff"}), 415),
        ]
        nested = b"leaf text"
        for index in range(5):
            nested = archive_bytes({f"{index}.zip": nested})
        cases.append((nested, 413))
        for data, status in cases:
            with self.subTest(status=status), self.assertRaises(InputError) as failure:
                extract(data)
            self.assertEqual(failure.exception.status, status)
        with self.assertRaises(InputError) as failure:
            extract(b"x" * (MAX_ATTACHMENT_BYTES + 1))
        self.assertEqual(failure.exception.status, 413)

    def test_mp4_frames_are_sampled_locally_without_audio(self):
        import av
        output = io.BytesIO()
        with av.open(output, "w", format="mp4") as container:
            stream = container.add_stream("mpeg4", rate=2)
            stream.width = stream.height = 32
            stream.pix_fmt = "yuv420p"
            for _ in range(4):
                with Image.new("RGB", (32, 32), "blue") as image:
                    frame = av.VideoFrame.from_image(image)
                for packet in stream.encode(frame):
                    container.mux(packet)
            for packet in stream.encode():
                container.mux(packet)
        result = extract(output.getvalue())
        self.assertEqual(len(result["vectors"]), 1)

    def test_malformed_files_and_empty_extraction_do_not_return_success(self):
        for data, media in ((b"%PDFbroken", ""), (b"\x00\xff", ""), (b"   ", "text/plain")):
            with self.assertRaises(InputError):
                extract(data, media)

    def test_http_attachment_contract_and_private_boundary(self):
        server = BoundedHTTPServer(
            ("127.0.0.1", 0), handler_for(PriorityEncoder(FakeEncoder())),
        )
        thread = threading.Thread(target=server.serve_forever)
        thread.start()
        try:
            for body, headers, status in (
                (request(image_bytes()), {}, 200),
                (request(b"bad", filename="unknown.bin"), {}, 415),
                ({**request(b"text"), "bytes_base64": "!!"}, {}, 400),
                (request(image_bytes()), {"Origin": "https://example.com"}, 403),
            ):
                connection = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=5)
                connection.request("POST", "/attachment", json.dumps(body),
                                   {"Content-Type": "application/json", **headers})
                response = connection.getresponse()
                self.assertEqual(response.status, status)
                value = json.loads(response.read())
                if status == 200:
                    self.assertEqual(value["descriptor"], DESCRIPTOR)
                    self.assertEqual(len(value["vectors"]), 1)
                connection.close()
        finally:
            server.shutdown()
            thread.join()
            server.server_close()

    def test_busy_attachment_rejected_before_body_read_and_slot_released(self):
        server = BoundedHTTPServer(("127.0.0.1", 0), handler_for(PriorityEncoder(FakeEncoder())))
        thread = threading.Thread(target=server.serve_forever)
        thread.start()
        try:
            with server.attachment_slots:
                connection = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=5)
                connection.putrequest("POST", "/attachment")
                connection.putheader("Content-Type", "application/json")
                connection.putheader("Content-Length", str(MAX_ATTACHMENT_BYTES))
                connection.endheaders()
                response = connection.getresponse()
                self.assertEqual(response.status, 503)
                response.read()
                connection.close()

                connection = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=5)
                connection.request("GET", "/health")
                response = connection.getresponse()
                self.assertEqual(response.status, 200)
                response.read()
                connection.close()

            for body, status in (({}, 409), (request(image_bytes()), 200)):
                connection = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=5)
                connection.request("POST", "/attachment", json.dumps(body),
                                   {"Content-Type": "application/json"})
                response = connection.getresponse()
                self.assertEqual(response.status, status)
                response.read()
                connection.close()
        finally:
            server.shutdown()
            thread.join()
            server.server_close()

    def test_interactive_queries_run_between_attachment_visual_units(self):
        started = threading.Event()
        release = threading.Event()
        order = []

        class Encoder(FakeEncoder):
            def image(self, image, mode=None):
                order.append("image")
                if self.images == 0:
                    started.set()
                    if not release.wait(5):
                        raise RuntimeError("test_timeout")
                return super().image(image, mode)

            def embed(self, texts, mode):
                order.append("query")
                return [[1.0] + [0.0] * 767]

        encoder = PriorityEncoder(Encoder())
        payload = request(archive_bytes({"first.jpg": image_bytes(), "second.jpg": image_bytes()}))
        document = threading.Thread(target=encoder.attachment, args=(payload,))
        query = threading.Thread(target=encoder.embed, args=(["interactive"], "query"))
        document.start()
        self.assertTrue(started.wait(5))
        query.start()
        try:
            with encoder.condition:
                self.assertTrue(encoder.condition.wait_for(
                    lambda: encoder.waiting_queries == 1, timeout=5,
                ))
        finally:
            release.set()
            document.join(5)
            query.join(5)
        self.assertFalse(document.is_alive() or query.is_alive())
        self.assertEqual(order, ["image", "query", "image"])


if __name__ == "__main__":
    unittest.main()
