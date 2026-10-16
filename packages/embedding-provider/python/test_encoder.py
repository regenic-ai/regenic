import unittest
import numpy as np
import torch
from serve import DESCRIPTOR, InputError, TextEncoder


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
        return np.array([self.vector for _text in texts], dtype=np.float32)


def encoder_with(vector):
    encoder = TextEncoder.__new__(TextEncoder)
    encoder.tokenizer = FakeTokenizer()
    encoder.model = FakeModel(vector)
    return encoder


class EncoderTests(unittest.TestCase):
    def test_float32_normalization_after_low_precision_inference(self):
        encoder = encoder_with([0.9984] + [0.0] * 767)
        vectors = encoder.embed(["synthetic"], "document")
        self.assertEqual(len(vectors[0]), DESCRIPTOR["dimensions"])
        self.assertAlmostEqual(np.linalg.norm(vectors[0]), 1.0, places=6)

    def test_invalid_vectors_are_not_repaired_into_success(self):
        for vector in ([0.0] * 768, [float("nan")] * 768, [1.0, 0.0]):
            with self.assertRaisesRegex(RuntimeError, "invalid_embedding_output"):
                encoder_with(vector).embed(["synthetic"], "query")

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
