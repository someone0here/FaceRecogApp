"""
evaluate.py
===========
Comprehensive evaluation of the exported TFLite model.

Produces:
  • Accuracy, Precision, Recall, F1-score per person
  • Confusion matrix plot
  • ROC curve + optimal similarity threshold
  • Speed benchmark table
  • Hackathon scorecard vs requirements

IMPORTANT — threshold alignment:
  SIM_THRESHOLD here MUST match SIMILARITY_THRESHOLD in
  FaceRecognitionService.ts (currently 0.75).
  If you change the threshold in the mobile app, update it here too,
  otherwise benchmark numbers won't reflect real app behaviour.

Run from: ~/FaceRecogApp/ai_model/src/
Command:  python3 evaluate.py
"""

import os
import time
import numpy as np
import tensorflow as tf
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from sklearn.metrics import (
    classification_report, confusion_matrix,
    roc_curve, auc, precision_recall_curve
)
from sklearn.model_selection import train_test_split

from dataset_loader import FaceDatasetLoader


DATASET_DIR    = '../dataset'
TFLITE_PATH    = '../tflite_models/face_embedding_int8.tflite'
MODEL_SAVE_DIR = '../saved_models'
EVAL_OUT_DIR   = '../evaluation'
IMAGE_SIZE     = (112, 112)
SIM_THRESHOLD  = 0.75    # Must match SIMILARITY_THRESHOLD in FaceRecognitionService.ts
                         # Using the same threshold ensures evaluation numbers reflect
                         # real app behaviour. Changed from 0.50 → 0.75 to match mobile.

os.makedirs(EVAL_OUT_DIR, exist_ok=True)


# ── TFLite inference helper ───────────────────────────────────────────────────

class TFLiteEmbedder:
    """Wraps the TFLite model for easy embedding extraction."""

    def __init__(self, model_path):
        self.interp = tf.lite.Interpreter(model_path=model_path)
        self.interp.allocate_tensors()
        self.inp_idx = self.interp.get_input_details()[0]['index']
        self.out_idx = self.interp.get_output_details()[0]['index']

    def embed(self, image_float32):
        """
        Args:
            image_float32: numpy array shape (112, 112, 3), range [0, 1]
        Returns:
            128-dim embedding vector
        """
        inp = image_float32[np.newaxis, ...].astype(np.float32)
        self.interp.set_tensor(self.inp_idx, inp)
        self.interp.invoke()
        return self.interp.get_tensor(self.out_idx)[0]

    def embed_batch(self, images):
        """Embed a batch of images, returns (N, 128) array."""
        return np.array([self.embed(img) for img in images])


# ── Evaluation functions ──────────────────────────────────────────────────────

def compute_all_embeddings(embedder, images, verbose=True):
    if verbose:
        print(f"  Embedding {len(images)} images...", end=' ', flush=True)
    embs = embedder.embed_batch(images)
    if verbose:
        print("done")
    return embs


def nearest_neighbour_recognition(embeddings, labels, threshold=None):
    """
    1-NN recognition using cosine similarity.

    For every image, compare against all others (leave-one-out).
    Predict the identity of the nearest neighbour.

    Returns:
        y_pred      – predicted label for each sample
        y_conf      – confidence (best similarity score)
        y_true      – ground truth labels
    """
    n       = len(embeddings)
    y_pred  = np.zeros(n, dtype=np.int32)
    y_conf  = np.zeros(n, dtype=np.float32)

    for i in range(n):
        best_sim  = -999.0
        best_lbl  = -1

        for j in range(n):
            if i == j:
                continue
            sim = float(np.dot(embeddings[i], embeddings[j]))
            if sim > best_sim:
                best_sim = sim
                best_lbl = labels[j]

        y_conf[i] = best_sim
        if threshold is not None and best_sim < threshold:
            y_pred[i] = -1   # Reject as unknown
        else:
            y_pred[i] = best_lbl

    return y_pred, y_conf


def find_optimal_threshold(embeddings, labels):
    """
    Find the cosine similarity threshold that maximises F1-score
    using the ROC curve approach.
    """
    # Build pairs: same-person vs different-person
    pairs_sim    = []
    pairs_same   = []

    n = len(embeddings)
    for i in range(n):
        for j in range(i + 1, n):
            sim  = float(np.dot(embeddings[i], embeddings[j]))
            same = int(labels[i] == labels[j])
            pairs_sim.append(sim)
            pairs_same.append(same)

    pairs_sim  = np.array(pairs_sim)
    pairs_same = np.array(pairs_same)

    # ROC curve (using similarity as score)
    fpr, tpr, thresholds = roc_curve(pairs_same, pairs_sim)
    roc_auc = auc(fpr, tpr)

    # Best threshold = where |TPR - FPR| is maximised (Youden's J)
    j_scores = tpr - fpr
    best_idx  = np.argmax(j_scores)
    best_thr  = thresholds[best_idx]

    return best_thr, roc_auc, fpr, tpr, thresholds


def plot_confusion_matrix(cm, label_names, save_path):
    fig, ax = plt.subplots(figsize=(max(6, len(label_names)),
                                    max(5, len(label_names) - 1)))
    im = ax.imshow(cm, interpolation='nearest', cmap='Blues')
    plt.colorbar(im, ax=ax)

    ax.set(xticks=range(len(label_names)),
           yticks=range(len(label_names)),
           xticklabels=label_names,
           yticklabels=label_names,
           ylabel='True label',
           xlabel='Predicted label',
           title='Confusion Matrix — Face Recognition')

    plt.setp(ax.get_xticklabels(), rotation=45,
             ha='right', rotation_mode='anchor')

    thresh = cm.max() / 2.0
    for i in range(cm.shape[0]):
        for j in range(cm.shape[1]):
            ax.text(j, i, format(cm[i, j], 'd'),
                    ha='center', va='center',
                    color='white' if cm[i, j] > thresh else 'black',
                    fontsize=10)

    fig.tight_layout()
    plt.savefig(save_path, dpi=150)
    plt.close()
    print(f"  Confusion matrix → {save_path}")


def plot_roc_curve(fpr, tpr, roc_auc, best_thr, save_path):
    plt.figure(figsize=(7, 6))
    plt.plot(fpr, tpr, color='steelblue', linewidth=2,
             label=f'ROC AUC = {roc_auc:.3f}')
    plt.plot([0, 1], [0, 1], 'k--', linewidth=1)
    plt.xlabel('False Positive Rate')
    plt.ylabel('True Positive Rate')
    plt.title('ROC Curve — Face Pair Verification')
    plt.legend()
    plt.grid(True, alpha=0.3)
    plt.tight_layout()
    plt.savefig(save_path, dpi=150)
    plt.close()
    print(f"  ROC curve        → {save_path}")


def speed_benchmark(embedder, num_runs=100):
    """Measure TFLite inference latency."""
    dummy = np.random.random((112, 112, 3)).astype(np.float32)

    # Warm-up
    for _ in range(5):
        embedder.embed(dummy)

    times = []
    for _ in range(num_runs):
        t0 = time.perf_counter()
        embedder.embed(dummy)
        times.append((time.perf_counter() - t0) * 1000)

    return {
        'mean':  np.mean(times),
        'std':   np.std(times),
        'p50':   np.percentile(times, 50),
        'p95':   np.percentile(times, 95),
        'p99':   np.percentile(times, 99),
        'min':   np.min(times),
        'max':   np.max(times),
    }


def print_benchmark_table(speed, model_mb, rec_acc, f1):
    """Print a formatted table for the hackathon presentation."""
    print("\n" + "╔" + "═" * 53 + "╗")
    print("║  HACKATHON SCORECARD                                ║")
    print("╠" + "═" * 53 + "╣")

    rows = [
        ("Model size",         f"{model_mb:.2f} MB",
         "≤ 20 MB",     model_mb <= 20),
        ("Recognition acc.",   f"{rec_acc:.1f}%",
         "> 95%",        rec_acc  >= 95),
        ("F1 score",           f"{f1:.3f}",
         "> 0.95",       f1       >= 0.95),
        ("Avg latency (Mac)",  f"{speed['mean']:.1f} ms",
         "< 1000 ms",   speed['mean'] < 1000),
        ("P95 latency (Mac)",  f"{speed['p95']:.1f} ms",
         "< 1000 ms",   speed['p95']  < 1000),
    ]

    for name, value, target, passed in rows:
        icon = "✅" if passed else "⚠️ "
        print(f"║  {icon}  {name:<22}  {value:>10}   {target:<10} ║")

    print("╚" + "═" * 53 + "╝")

    print("\n  Note: Latency on mid-range Android (3GB RAM, no GPU)")
    print(f"  estimated at {speed['mean']*4:.0f}–{speed['mean']*6:.0f} ms")
    print("  (multiply Mac latency by ~4–6×)")


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    print("\n" + "=" * 55)
    print("  PHASE 2 — Model Evaluation")
    print("=" * 55)

    # Load TFLite model
    if not os.path.exists(TFLITE_PATH):
        print(f"\n❌ TFLite model not found: {TFLITE_PATH}")
        print("   Run export_tflite.py first!")
        return

    model_mb = os.path.getsize(TFLITE_PATH) / (1024 ** 2)
    print(f"\nTFLite model : {TFLITE_PATH}  ({model_mb:.2f} MB)")
    embedder = TFLiteEmbedder(TFLITE_PATH)

    # Load dataset
    if not os.path.exists(DATASET_DIR):
        print(f"\n❌ Dataset not found: {DATASET_DIR}")
        return

    print("\n[1/5] Loading dataset...")
    loader = FaceDatasetLoader(DATASET_DIR, image_size=IMAGE_SIZE)
    images, labels, label_names = loader.load_dataset(
        save_calibration_images=False
    )
    num_classes = len(label_names)
    print(f"  {len(images)} images, {num_classes} identities")

    # Split — use the same seed as train.py for fair evaluation
    _, X_test, _, y_test = train_test_split(
        images, labels,
        test_size=0.20,
        random_state=42,
        stratify=labels
    )
    print(f"  Test set: {len(X_test)} images")

    # Compute embeddings
    print("\n[2/5] Computing embeddings...")
    embeddings = compute_all_embeddings(embedder, X_test)

    # Find optimal threshold
    print("\n[3/5] Finding optimal similarity threshold...")
    best_thr, roc_auc, fpr, tpr, thresholds = find_optimal_threshold(
        embeddings, y_test
    )
    print(f"  ROC AUC         : {roc_auc:.4f}")
    print(f"  Optimal threshold: {best_thr:.3f}  "
          f"(override SIM_THRESHOLD in evaluate.py if needed)")

    # Recognition accuracy
    print("\n[4/5] Computing recognition metrics...")
    y_pred, y_conf = nearest_neighbour_recognition(
        embeddings, y_test, threshold=SIM_THRESHOLD
    )

    # Filter unknowns for classification report
    known_mask   = y_pred != -1
    y_true_known = y_test[known_mask]
    y_pred_known = y_pred[known_mask]

    rec_acc  = np.mean(y_pred_known == y_true_known) * 100
    unk_rate = np.mean(~known_mask) * 100

    print(f"\n  Recognition accuracy : {rec_acc:.2f}%")
    print(f"  Unknown rejection    : {unk_rate:.2f}%")

    # Per-class metrics
    if len(np.unique(y_true_known)) > 1:
        report = classification_report(
            y_true_known,
            y_pred_known,
            target_names=label_names,
            output_dict=True,
            zero_division=0
        )
        macro_f1        = report['macro avg']['f1-score']
        macro_precision = report['macro avg']['precision']
        macro_recall    = report['macro avg']['recall']

        print(f"\n  Macro F1-score    : {macro_f1:.4f}")
        print(f"  Macro Precision   : {macro_precision:.4f}")
        print(f"  Macro Recall      : {macro_recall:.4f}")

        print("\n  Per-person breakdown:")
        print(f"  {'Person':<25} {'Precision':>10} {'Recall':>8} {'F1':>8} {'Support':>9}")
        print("  " + "-" * 65)
        for name in label_names:
            if name in report:
                r = report[name]
                print(f"  {name:<25} {r['precision']:>10.3f} "
                      f"{r['recall']:>8.3f} {r['f1-score']:>8.3f} "
                      f"{int(r['support']):>9}")
    else:
        macro_f1 = rec_acc / 100

    # Plots
    cm = confusion_matrix(y_true_known, y_pred_known)
    plot_confusion_matrix(cm, label_names,
                          os.path.join(EVAL_OUT_DIR, 'confusion_matrix.png'))
    plot_roc_curve(fpr, tpr, roc_auc, best_thr,
                   os.path.join(EVAL_OUT_DIR, 'roc_curve.png'))

    # Speed benchmark
    print("\n[5/5] Speed benchmark (100 runs)...")
    speed = speed_benchmark(embedder)
    print(f"  Mean    : {speed['mean']:.2f} ms")
    print(f"  Std dev : {speed['std']:.2f} ms")
    print(f"  P50     : {speed['p50']:.2f} ms")
    print(f"  P95     : {speed['p95']:.2f} ms")
    print(f"  P99     : {speed['p99']:.2f} ms")

    # Hackathon scorecard
    print_benchmark_table(speed, model_mb, rec_acc, macro_f1)

    # Save metrics to text file
    metrics_path = os.path.join(EVAL_OUT_DIR, 'metrics.txt')
    with open(metrics_path, 'w') as f:
        f.write("FACE RECOGNITION MODEL — EVALUATION REPORT\n")
        f.write("=" * 50 + "\n\n")
        f.write(f"Model file      : {TFLITE_PATH}\n")
        f.write(f"Model size      : {model_mb:.2f} MB\n")
        f.write(f"Test samples    : {len(X_test)}\n")
        f.write(f"Identities      : {num_classes}\n\n")
        f.write(f"Recognition Acc : {rec_acc:.2f}%\n")
        f.write(f"ROC AUC         : {roc_auc:.4f}\n")
        f.write(f"Macro F1        : {macro_f1:.4f}\n")
        f.write(f"Optimal Thresh  : {best_thr:.3f}\n\n")
        f.write(f"Latency (mean)  : {speed['mean']:.2f} ms\n")
        f.write(f"Latency (P95)   : {speed['p95']:.2f} ms\n")
    print(f"\n  Full metrics → {metrics_path}")

    print("\n✅ Evaluation complete. Check the evaluation/ folder.")
    print("=" * 55 + "\n")


if __name__ == '__main__':
    main()
