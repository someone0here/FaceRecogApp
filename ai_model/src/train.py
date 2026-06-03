"""
train.py
========
Full training pipeline for the face recognition model.

What this script does:
  1. Loads face images from dataset/ folder
  2. Splits into train (80%) and validation (20%)
  3. Builds MobileNetV2 embedding model
  4. Trains with softmax cross-entropy loss
  5. Evaluates recognition accuracy using cosine similarity
  6. Saves the trained embedding model to saved_models/

Run from: ~/FaceRecogApp/ai_model/src/
Command:  python3 train.py
"""

import os
import sys
import numpy as np
import tensorflow as tf
from sklearn.model_selection import train_test_split
from sklearn.metrics import classification_report, confusion_matrix
import matplotlib
matplotlib.use('Agg')   # Non-interactive backend — saves plots to file
import matplotlib.pyplot as plt

# Local modules
from embedding_model import build_embedding_model, build_training_model
from dataset_loader  import FaceDatasetLoader

# ── Configuration ─────────────────────────────────────────────────────────────
DATASET_DIR    = '../dataset'          # One sub-folder per person
MODEL_SAVE_DIR = '../saved_models'
IMAGE_SIZE     = (112, 112)
BATCH_SIZE     = 32
EPOCHS         = 60                   # EarlyStopping will cut this short
LEARNING_RATE  = 0.001
EMBEDDING_DIM  = 128
MIN_IMAGES_PER_CLASS = 2              # Warn if fewer than this
# ─────────────────────────────────────────────────────────────────────────────

os.makedirs(MODEL_SAVE_DIR, exist_ok=True)


# ── Helpers ───────────────────────────────────────────────────────────────────

def plot_training_history(history, save_path):
    """Save accuracy + loss curves to PNG."""
    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(14, 5))

    ax1.plot(history.history['accuracy'],     label='Train', linewidth=2)
    ax1.plot(history.history['val_accuracy'], label='Val',   linewidth=2)
    ax1.set_title('Accuracy over Epochs', fontsize=13)
    ax1.set_xlabel('Epoch'); ax1.set_ylabel('Accuracy')
    ax1.legend(); ax1.grid(True, alpha=0.3)
    ax1.set_ylim([0, 1.05])

    ax2.plot(history.history['loss'],     label='Train', linewidth=2)
    ax2.plot(history.history['val_loss'], label='Val',   linewidth=2)
    ax2.set_title('Loss over Epochs', fontsize=13)
    ax2.set_xlabel('Epoch'); ax2.set_ylabel('Loss')
    ax2.legend(); ax2.grid(True, alpha=0.3)

    plt.tight_layout()
    plt.savefig(save_path, dpi=150)
    plt.close()
    print(f"  Training plot → {save_path}")


def evaluate_recognition_accuracy(embedding_model, X_test, y_test,
                                   label_names, threshold=0.5):
    """
    Measures REAL face recognition accuracy using 1-Nearest-Neighbour
    cosine similarity — this is exactly how the mobile app works.

    For every test image:
      1. Compute its 128-dim embedding
      2. Find the most similar embedding from all OTHER test images
      3. Check if that nearest neighbour belongs to the same person

    Args:
        threshold: cosine similarity below this → "Unknown person"
                   Must match SIMILARITY_THRESHOLD in FaceRecognitionService.ts (0.75).
                   Set to None to disable Unknown rejection and measure raw 1-NN accuracy.

    Returns:
        recognition_accuracy (float), unknown_rate (float)
    """
    print("  Computing embeddings for all test images...", end=' ', flush=True)
    embeddings = embedding_model.predict(X_test, batch_size=32, verbose=0)
    print("done")

    correct  = 0
    unknown  = 0
    total    = len(embeddings)

    for i in range(total):
        query_emb = embeddings[i]
        best_sim   = -999.0
        best_label = -1

        for j in range(total):
            if i == j:
                continue
            # dot product of L2-normalised vectors = cosine similarity
            sim = float(np.dot(query_emb, embeddings[j]))
            if sim > best_sim:
                best_sim   = sim
                best_label = y_test[j]

        if threshold is not None and best_sim < threshold:
            unknown += 1
        elif best_label == y_test[i]:
            correct += 1

    recognition_acc = correct / total * 100
    unknown_rate    = unknown / total * 100
    return recognition_acc, unknown_rate


def save_label_names(label_names, save_dir):
    """
    Saves person names to two formats:
      label_names.txt  — one name per line (for the React Native app)
      label_names.npy  — numpy array (for Python scripts)
    """
    txt_path = os.path.join(save_dir, 'label_names.txt')
    npy_path = os.path.join(save_dir, 'label_names.npy')

    with open(txt_path, 'w') as f:
        for name in label_names:
            f.write(name + '\n')

    np.save(npy_path, np.array(label_names))
    print(f"  Label names → {txt_path}")
    print(f"  Label names → {npy_path}")


# ── Main Training Pipeline ────────────────────────────────────────────────────

def main():
    print("\n" + "=" * 55)
    print("  PHASE 2 — Face Recognition Model Training")
    print("=" * 55)

    # ── Step 1: Load dataset ─────────────────────────────────────────────────
    print("\n[1/6] Loading and detecting faces from dataset/...")

    if not os.path.exists(DATASET_DIR):
        print(f"\n❌ dataset/ folder not found at: {os.path.abspath(DATASET_DIR)}")
        print("\nCreate it like this:")
        print("  mkdir -p ../dataset/YourName")
        print("  # Then copy your face photos into ../dataset/YourName/")
        sys.exit(1)

    loader = FaceDatasetLoader(
        DATASET_DIR,
        image_size=IMAGE_SIZE,
        batch_size=BATCH_SIZE
    )
    images, labels, label_names = loader.load_dataset(
        save_calibration_images=True
    )
    num_classes = len(label_names)

    # Sanity check
    class_counts = np.bincount(labels)
    if any(c < MIN_IMAGES_PER_CLASS for c in class_counts):
        print("\n⚠️  Some classes have very few images — accuracy may be low")
        print("   Recommended: at least 10 images per person")

    print(f"\n  Dataset ready: {len(images)} images, "
          f"{num_classes} people, shape={images.shape[1:]}")

    # ── Step 2: Train / val split ────────────────────────────────────────────
    print("\n[2/6] Splitting train/validation...")

    # stratify=labels ensures each person appears proportionally in both sets
    X_train, X_val, y_train, y_val = train_test_split(
        images, labels,
        test_size=0.20,
        random_state=42,
        stratify=labels
    )
    print(f"  Train: {len(X_train)} images")
    print(f"  Val  : {len(X_val)}   images")

    # ── Step 3: Build model ──────────────────────────────────────────────────
    print("\n[3/6] Building MobileNetV2 model...")

    embedding_model = build_embedding_model(
        input_shape=(*IMAGE_SIZE, 3),
        embedding_dim=EMBEDDING_DIM
    )
    training_model = build_training_model(embedding_model, num_classes)

    training_model.compile(
        optimizer=tf.keras.optimizers.Adam(learning_rate=LEARNING_RATE),
        loss='sparse_categorical_crossentropy',
        metrics=['accuracy']
    )

    emb_params   = embedding_model.count_params()
    total_params = training_model.count_params()
    print(f"  Embedding model params : {emb_params:,}")
    print(f"  Full training params   : {total_params:,}")
    print(f"  Approx FP32 size       : "
          f"~{emb_params * 4 / 1024 / 1024:.1f} MB")

    # ── Step 4: Train ────────────────────────────────────────────────────────
    print("\n[4/6] Training...")

    callbacks = [
        # Stop training if val_accuracy doesn't improve for 12 epochs
        tf.keras.callbacks.EarlyStopping(
            monitor='val_accuracy',
            patience=12,
            restore_best_weights=True,
            verbose=1
        ),
        # Halve learning rate if val_loss plateaus for 6 epochs
        tf.keras.callbacks.ReduceLROnPlateau(
            monitor='val_loss',
            factor=0.5,
            patience=6,
            min_lr=1e-7,
            verbose=1
        ),
        # Save the best checkpoint automatically
        tf.keras.callbacks.ModelCheckpoint(
            filepath=os.path.join(MODEL_SAVE_DIR, 'best_model.keras'),
            monitor='val_accuracy',
            save_best_only=True,
            verbose=1
        ),
    ]

    train_ds = loader.create_tf_dataset(X_train, y_train, augment=True)
    val_ds   = loader.create_tf_dataset(X_val,   y_val,   augment=False)

    history = training_model.fit(
        train_ds,
        validation_data=val_ds,
        epochs=EPOCHS,
        callbacks=callbacks,
        verbose=1
    )

    # ── Step 5: Evaluate ─────────────────────────────────────────────────────
    print("\n[5/6] Evaluating...")

    # Classification accuracy (softmax head)
    val_loss, val_cls_acc = training_model.evaluate(val_ds, verbose=0)
    print(f"  Classification accuracy  : {val_cls_acc * 100:.2f}%")

    # Recognition accuracy (cosine similarity — same as mobile app)
    rec_acc, unk_rate = evaluate_recognition_accuracy(
        embedding_model, X_val, y_val, label_names, threshold=0.75
        # 0.75 matches SIMILARITY_THRESHOLD in FaceRecognitionService.ts
        # so reported accuracy reflects what the mobile app will actually achieve
    )
    print(f"  Recognition accuracy     : {rec_acc:.2f}%")
    print(f"  Unknown rejection rate   : {unk_rate:.2f}%")

    target_met = "✅" if rec_acc >= 95 else "⚠️ "
    print(f"\n  {target_met} Hackathon target (>95%): "
          f"{'PASSED' if rec_acc >= 95 else 'NOT YET — add more training data'}")

    # ── Step 6: Save ─────────────────────────────────────────────────────────
    print("\n[6/6] Saving model and metadata...")

    emb_path = os.path.join(MODEL_SAVE_DIR, 'embedding_model.keras')
    embedding_model.save(emb_path)
    print(f"  Embedding model → {emb_path}")

    save_label_names(label_names, MODEL_SAVE_DIR)
    plot_training_history(
        history,
        os.path.join(MODEL_SAVE_DIR, 'training_history.png')
    )

    # ── Summary ──────────────────────────────────────────────────────────────
    print("\n" + "=" * 55)
    print("  TRAINING COMPLETE")
    print("=" * 55)
    print(f"  People trained on       : {num_classes}")
    print(f"  Total training images   : {len(X_train)}")
    print(f"  Classification accuracy : {val_cls_acc * 100:.2f}%")
    print(f"  Recognition accuracy    : {rec_acc:.2f}%")
    print(f"  Model saved to          : {MODEL_SAVE_DIR}/")
    print("\n  Next step: run  python3 export_tflite.py")
    print("=" * 55 + "\n")


if __name__ == '__main__':
    main()
