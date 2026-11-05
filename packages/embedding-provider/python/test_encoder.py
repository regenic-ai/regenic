import unittest
from unittest.mock import Mock, patch
import numpy as np
import torch
from serve import DESCRIPTOR, InputError, TextEncoder, initialize_encoder


class FakeTokenizer:
    def __call__(self, texts, **kwargs):
        return {"input_ids": [[1] * len(text) for text in texts]}


class FakeModel:
    def __init__(self, vector):
        self.vector = vector
        self.truncate = False

    def preprocess(self, texts):
        mask = [[1] * len(text) for text in texts]
        if self.truncate:
            mask[0].pop()
        return {"attention_mask": torch.tensor(mask)}

    def encode(self, texts, **kwargs):
        self.inputs = texts
        self.kwargs = kwargs
        return np.array([self.vector for _text in texts], dtype=np.float32)


def encoder_with(vector):
    encoder = TextEncoder.__new__(TextEncoder)
    encoder.tokenizer = FakeTokenizer()
    encoder.model = FakeModel(vector)
    return encoder


class EncoderTests(unittest.TestCase):
    def test_cpu_defaults_to_bfloat16_and_keeps_vision_enabled(self):
        model = FakeModel([1.0] + [0.0] * 767)
        with patch("sentence_transformers.SentenceTransformer", return_value=model) as constructor, \
                patch("transformers.AutoTokenizer.from_pretrained", return_value=FakeTokenizer()):
            TextEncoder("cpu")
        self.assertEqual(constructor.call_args.kwargs["model_kwargs"], {"dtype": "bfloat16"})
        self.assertEqual(constructor.call_args.kwargs["config_kwargs"], {"audio_config": None})

    def test_cpu_float32_fallback_is_explicit(self):
        model = FakeModel([1.0] + [0.0] * 767)
        with patch("sentence_transformers.SentenceTransformer", return_value=model) as constructor, \
                patch("transformers.AutoTokenizer.from_pretrained", return_value=FakeTokenizer()):
            TextEncoder("cpu", "float32")
        self.assertEqual(constructor.call_args.kwargs["model_kwargs"], {"dtype": "float32"})
        with self.assertRaisesRegex(ValueError, "unsupported precision"):
            TextEncoder("cpu", "float16")

    def test_explicit_mps_precision_is_applied_to_model_weights(self):
        model = FakeModel([1.0] + [0.0] * 767)
        with patch("sentence_transformers.SentenceTransformer", return_value=model) as constructor, \
                patch("transformers.AutoTokenizer.from_pretrained", return_value=FakeTokenizer()):
            TextEncoder("mps", "float32")
        self.assertEqual(constructor.call_args.kwargs["device"], "mps")
        self.assertEqual(constructor.call_args.kwargs["model_kwargs"], {"dtype": "float32"})

    def test_auto_mps_requires_query_document_image_and_video_verification(self):
        model = Mock()
        with patch("torch.backends.mps.is_available", return_value=True), \
                patch("serve.TextEncoder", return_value=model) as constructor:
            encoder, runtime = initialize_encoder("auto-mps", "bfloat16")
        constructor.assert_called_once_with("mps", "float32")
        self.assertIs(encoder, model)
        self.assertEqual(runtime, {"device": "mps", "precision": "float32"})
        self.assertEqual([call.args[1] for call in model.embed.call_args_list], ["query", "document"])
        model.image.assert_called_once()
        model.video.assert_called_once()

    def test_unavailable_mps_uses_cpu_and_reports_reason(self):
        with patch("torch.backends.mps.is_available", return_value=False), \
                patch("serve.TextEncoder") as constructor, \
                self.assertLogs(level="WARNING"):
            _, runtime = initialize_encoder("auto-mps", "float32")
        constructor.assert_called_once_with("cpu", "float32")
        self.assertEqual(runtime, {"device": "cpu", "precision": "float32", "fallback_reason": "mps_unavailable"})

    def test_mps_load_and_inference_failures_retry_cpu_explicitly(self):
        for phase in ("load", "query", "document", "image", "video"):
            model = Mock()
            if phase == "query":
                model.embed.side_effect = NotImplementedError("unsupported operation")
            elif phase == "document":
                model.embed.side_effect = [None, RuntimeError("unsupported document")]
            elif phase == "image":
                model.image.side_effect = RuntimeError("unsupported image")
            elif phase == "video":
                model.video.side_effect = RuntimeError("unsupported video")
            candidates = [RuntimeError("MPS allocation failed") if phase == "load" else model, Mock()]
            with self.subTest(phase=phase), \
                    patch("torch.backends.mps.is_available", return_value=True), \
                    patch("torch.mps.empty_cache") as empty_cache, \
                    patch("serve.TextEncoder", side_effect=candidates) as constructor, \
                    self.assertLogs(level="WARNING"):
                encoder, runtime = initialize_encoder("auto-mps", "float32")
            self.assertEqual([call.args for call in constructor.call_args_list], [("mps", "float32"), ("cpu", "float32")])
            self.assertIs(encoder, candidates[1])
            empty_cache.assert_called_once()
            self.assertEqual(runtime["fallback_reason"], "mps_failed")
            self.assertEqual(runtime["device"], "cpu")

    def test_unrelated_errors_and_cpu_failure_are_not_hidden(self):
        with patch("torch.backends.mps.is_available", return_value=True), \
                patch("serve.TextEncoder", side_effect=ValueError("invalid model")):
            with self.assertRaisesRegex(ValueError, "invalid model"):
                initialize_encoder("auto-mps", "float32")
        with patch("torch.backends.mps.is_available", return_value=False), \
                patch("serve.TextEncoder", side_effect=RuntimeError("CPU failed")), \
                self.assertLogs(level="WARNING"):
            with self.assertRaisesRegex(RuntimeError, "CPU failed"):
                initialize_encoder("auto-mps", "float32")
        with patch("torch.backends.mps.is_available") as available, \
                patch("serve.TextEncoder") as constructor:
            initialize_encoder("cpu", "bfloat16")
        available.assert_not_called()
        constructor.assert_called_once_with("cpu", "bfloat16")

    def test_float32_normalization_after_low_precision_inference(self):
        encoder = encoder_with([0.9984] + [0.0] * 767)
        counts, vectors = encoder.embed_with_counts(["synthetic"], "document")
        self.assertEqual(counts, [len("title: none | text: synthetic")])
        self.assertEqual(len(vectors[0]), DESCRIPTOR["dimensions"])
        self.assertAlmostEqual(np.linalg.norm(vectors[0]), 1.0, places=6)
        self.assertEqual(encoder.embed(["synthetic"], "document"), vectors)

    def test_invalid_vectors_are_not_repaired_into_success(self):
        for vector in ([0.0] * 768, [float("nan")] * 768, [1.0, 0.0]):
            with self.assertRaisesRegex(RuntimeError, "invalid_embedding_output"):
                encoder_with(vector).embed(["synthetic"], "query")

    def test_image_encoding_has_no_text_task_prefix_and_normalizes_output(self):
        encoder = encoder_with([0.9984] + [0.0] * 767)
        vector = encoder.image("synthetic image")
        self.assertAlmostEqual(np.linalg.norm(vector), 1.0, places=6)
        self.assertEqual(encoder.model.kwargs["prompt"], "")
        self.assertEqual(encoder.model.inputs, [
            {"text": "<|image|>", "image": ["synthetic image"]},
        ])
        for invalid in ([0.0] * 768, [float("nan")] * 768, [1.0, 0.0]):
            with self.assertRaisesRegex(RuntimeError, "invalid_embedding_output"):
                encoder_with(invalid).image("synthetic image")

    def test_native_video_preserves_sampled_frame_metadata_without_text_prompts(self):
        encoder = encoder_with([0.9984] + [0.0] * 767)
        self.assertAlmostEqual(np.linalg.norm(encoder.video(["first", "second"])), 1.0, places=6)
        self.assertEqual(encoder.model.kwargs["prompt"], "")
        self.assertEqual(encoder.model.inputs[0]["text"], "<|video|>")
        self.assertEqual(encoder.model.inputs[0]["video"]["video_metadata"], {
            "fps": 1.0, "total_num_frames": 2, "duration": 2.0, "frames_indices": [0, 1],
        })

    def test_truncation_and_oversized_input_are_rejected(self):
        encoder = encoder_with([1.0] + [0.0] * 767)
        encoder.model.truncate = True
        with self.assertRaises(InputError) as failure:
            encoder.embed(["synthetic"], "query")
        self.assertEqual(failure.exception.status, 409)
        with self.assertRaises(InputError) as failure:
            encoder.embed(["x" * 8192], "query")
        self.assertEqual(failure.exception.status, 413)


if __name__ == "__main__":
    unittest.main()
