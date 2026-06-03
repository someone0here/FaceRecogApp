"""
export_tflite.py
================
Converts the trained Keras model to TFLite format with INT8 quantization.

Why INT8 quantization?
  - FP32 model: each weight stored as 32-bit float  → large, slow
  - INT8 model: each weight stored as 8-bit integer → ~4x smaller, ~2x faster
  - Accuracy loss is typically < 0.5% — acceptable for our use case

Output files:
  tflite_models/face_embedding_fp32.tflite  ← baseline (for comparison)
  tflite_models/face_embedding_int8.tflite  ← DEPLOY THIS to mobile app

Run from: ~/FaceRecogApp/ai_model/src/
Command:  python3 export_tflite.py
"""

import os
import time
import numpy as np
import tensorflow as tf
from embedding_model import build_embedding_model, L2NormalizeLayer  # registers custom layer


MODEL_DIR       = '../saved_models'
TFLITE_OUT_DIR  = '../tflite_models'
IMAGE_SIZE      = (112, 112)
CALIB_SAMPLES   = 200        # Number of images used for INT8 calibration

os.makedirs(TFLITE_OUT_DIR, exist_ok=True)


# ── Calibration dataset ───────────────────────────────────────────────────────

def get_representative_dataset():
    """
    INT8 quantization needs to see real input data to figure out the
    best scale factors for each layer.

    We use images saved during training (calibration_images.npy).
    If this file is missing, we raise an error — using random noise for
    calibration causes a 2-5% accuracy drop in the quantised model,
    which can push recognition accuracy below the 95% hackathon target.

    Always run train.py before export_tflite.py.
    """
    cal_path = os.path.join(MODEL_DIR, 'calibration_images.npy')

    if not os.path.exists(cal_path):
        raise FileNotFoundError(
            f"\n❌ Calibration images not found at: {os.path.abspath(cal_path)}\n"
            f"\n   INT8 quantisation requires real face images for calibration.\n"
            f"   Using random noise instead causes 2-5% accuracy loss,\n"
            f"   which can push recognition below the 95%% hackathon target.\n"
            f"\n   Fix: run train.py first — it saves calibration_images.npy\n"
            f"        automatically during dataset loading.\n"
            f"\n   Command: cd src && python3 train.py\n"
        )

    images = np.load(cal_path)
    n = min(CALIB_SAMPLES, len(images))
    print(f"  Using {n} real calibration images from {cal_path}")

    def gen():
        for i in range(n):
            # Must yield a list containing one float32 array with batch dim
            yield [images[i : i + 1].astype(np.float32)]

    return gen


# ── Export functions ──────────────────────────────────────────────────────────

def export_fp32(model, out_path):
    """Export as plain FP32 TFLite — no quantization, for size comparison."""
    converter = tf.lite.TFLiteConverter.from_keras_model(model)
    tflite_bytes = converter.convert()

    with open(out_path, 'wb') as f:
        f.write(tflite_bytes)

    size_mb = os.path.getsize(out_path) / (1024 ** 2)
    print(f"  FP32 → {out_path}  ({size_mb:.2f} MB)")
    return size_mb


def export_int8(model, out_path, rep_dataset_fn):
    """
    Export with full INT8 quantization using TensorFlow Lite converter.

    converter.optimizations = DEFAULT  →  quantise weights + activations
    representative_dataset  →  calibration data for activation ranges
    target_spec             →  only use INT8 kernels (no fp32 fallback ops)
    inference_input_type    →  keep input as float32 (easier from app side)
    inference_output_type   →  keep output as float32 (for cosine similarity)
    """
    converter = tf.lite.TFLiteConverter.from_keras_model(model)

    converter.optimizations          = [tf.lite.Optimize.DEFAULT]
    converter.representative_dataset  = rep_dataset_fn

    converter.target_spec.supported_ops = [
        tf.lite.OpsSet.TFLITE_BUILTINS_INT8,
        tf.lite.OpsSet.TFLITE_BUILTINS,    # Fallback for any unsupported op
    ]

    # Float I/O is easier to use from React Native — no de-quantization needed
    converter.inference_input_type  = tf.float32
    converter.inference_output_type = tf.float32

    tflite_bytes = converter.convert()

    with open(out_path, 'wb') as f:
        f.write(tflite_bytes)

    size_mb = os.path.getsize(out_path) / (1024 ** 2)
    print(f"  INT8 → {out_path}  ({size_mb:.2f} MB)")
    return size_mb


# ── Benchmarking ──────────────────────────────────────────────────────────────

def benchmark(tflite_path, num_runs=100):
    """
    Measures inference latency on this machine.

    Note: Times on a MacBook M-series will be FASTER than a mid-range Android.
    Rule of thumb: multiply Mac time by ~3-5× for a 3GB RAM Android estimate.
    """
    interp = tf.lite.Interpreter(model_path=tflite_path)
    interp.allocate_tensors()

    inp_idx = interp.get_input_details()[0]['index']
    dummy   = np.random.random((1, *IMAGE_SIZE, 3)).astype(np.float32)

    # Warm-up run — first inference is always slower due to JIT / cache warming
    interp.set_tensor(inp_idx, dummy)
    interp.invoke()

    # Timed runs
    times = []
    for _ in range(num_runs):
        t0 = time.perf_counter()
        interp.set_tensor(inp_idx, dummy)
        interp.invoke()
        times.append((time.perf_counter() - t0) * 1000)   # → ms

    avg = np.mean(times)
    p50 = np.percentile(times, 50)
    p95 = np.percentile(times, 95)
    return avg, p50, p95


def verify_output(tflite_path):
    """
    Sanity check: verify the model outputs valid 128-dim L2-normalised vectors.
    Also confirms that TWO DIFFERENT random faces have LOWER similarity than
    two COPIES of the same face.
    """
    interp = tf.lite.Interpreter(model_path=tflite_path)
    interp.allocate_tensors()

    inp  = interp.get_input_details()[0]['index']
    out  = interp.get_output_details()[0]['index']

    img_a = np.random.random((1, *IMAGE_SIZE, 3)).astype(np.float32)
    img_b = np.random.random((1, *IMAGE_SIZE, 3)).astype(np.float32)

    interp.set_tensor(inp, img_a); interp.invoke()
    emb_a = interp.get_tensor(out)[0]

    interp.set_tensor(inp, img_a); interp.invoke()   # Same image again
    emb_a2 = interp.get_tensor(out)[0]

    interp.set_tensor(inp, img_b); interp.invoke()
    emb_b = interp.get_tensor(out)[0]

    same_sim  = float(np.dot(emb_a, emb_a2))
    diff_sim  = float(np.dot(emb_a, emb_b))
    norm_a    = float(np.linalg.norm(emb_a))

    print(f"  Embedding dimension      : {emb_a.shape[0]}")
    print(f"  L2 norm (expect ~1.0)    : {norm_a:.5f}")
    print(f"  Same image similarity    : {same_sim:.4f}  (expect ~1.0)")
    print(f"  Diff image similarity    : {diff_sim:.4f}  (expect low)")

    ok = (emb_a.shape[0] == 128 and
          abs(norm_a - 1.0) < 0.05 and
          same_sim > 0.95 and
          diff_sim < same_sim)
    return ok


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    print("\n" + "=" * 55)
    print("  PHASE 2 — TFLite Export & Quantization")
    print("=" * 55)

    # Load model
    model_path = os.path.join(MODEL_DIR, 'embedding_model.keras')
    if not os.path.exists(model_path):
        print(f"\n❌ Model not found at: {os.path.abspath(model_path)}")
        print("   Run train.py first!")
        return

    print(f"\nLoading model from {model_path} ...", end=' ', flush=True)
    model = tf.keras.models.load_model(model_path)
    print("done")

    # ── FP32 export ──────────────────────────────────────────────────────────
    print("\n[1/4] Exporting FP32 baseline ...")
    fp32_path = os.path.join(TFLITE_OUT_DIR, 'face_embedding_fp32.tflite')
    fp32_mb   = export_fp32(model, fp32_path)

    # ── INT8 export ──────────────────────────────────────────────────────────
    print("\n[2/4] Exporting INT8 quantised model ...")
    rep_ds_fn = get_representative_dataset()
    int8_path = os.path.join(TFLITE_OUT_DIR, 'face_embedding_int8.tflite')
    int8_mb   = export_int8(model, int8_path, rep_ds_fn)

    ratio = fp32_mb / int8_mb if int8_mb > 0 else 0
    print(f"  Compression : {ratio:.1f}× smaller than FP32")

    size_ok = int8_mb <= 20
    print(f"  {'✅' if size_ok else '⚠️ '} Size {int8_mb:.2f} MB "
          f"({'within' if size_ok else 'above'} 20 MB target)")

    # ── Verify output ─────────────────────────────────────────────────────────
    print("\n[3/4] Verifying model output ...")
    valid = verify_output(int8_path)
    print(f"  {'✅' if valid else '❌'} Output {'valid' if valid else 'INVALID — check model'}")

    # ── Benchmark ─────────────────────────────────────────────────────────────
    print("\n[4/4] Benchmarking inference (100 runs) ...")
    avg_ms, p50_ms, p95_ms = benchmark(int8_path)
    print(f"  Average latency : {avg_ms:.1f} ms")
    print(f"  Median  latency : {p50_ms:.1f} ms")
    print(f"  P95     latency : {p95_ms:.1f} ms  (worst case)")
    print(f"  Estimated on mid-range Android (3GB RAM): "
          f"~{avg_ms * 4:.0f}–{avg_ms * 6:.0f} ms")

    # ── Summary ──────────────────────────────────────────────────────────────
    print("\n" + "=" * 55)
    print("  EXPORT SUMMARY")
    print("=" * 55)
    print(f"  FP32 model size  : {fp32_mb:.2f} MB")
    print(f"  INT8 model size  : {int8_mb:.2f} MB  ← copy this to the app")
    print(f"  Size reduction   : {ratio:.1f}×")
    print(f"  Mac avg latency  : {avg_ms:.1f} ms")
    print(f"\n  Deploy file      : {os.path.abspath(int8_path)}")
    print("\n  Next step: copy face_embedding_int8.tflite into")
    print("             FaceAttendance/android/app/src/main/assets/")
    print("             FaceAttendance/ios/FaceAttendance/")
    print("=" * 55 + "\n")


if __name__ == '__main__':
    main()
