"""
embedding_model.py  (fixed — no Lambda layer)
==============================================
MobileNetV2-based face embedding model.

Change from v1: replaced tf.keras Lambda layer with a proper subclassed
layer (L2NormalizeLayer) so Keras 3 can save/load it without safe_mode issues.
"""

import tensorflow as tf
import numpy as np


# ── Custom L2 normalisation layer (replaces Lambda) ───────────────────────────
@tf.keras.utils.register_keras_serializable(package='FaceRecog')
class L2NormalizeLayer(tf.keras.layers.Layer):
    """
    Divides each embedding vector by its own L2 norm so every output
    vector has length exactly 1.0.  This makes cosine similarity equal
    to a plain dot product — cheaper to compute on device.
    """
    def call(self, inputs):
        return tf.math.l2_normalize(inputs, axis=1)

    def get_config(self):
        return super().get_config()


# ── Model builder ─────────────────────────────────────────────────────────────

def build_embedding_model(input_shape=(112, 112, 3), embedding_dim=128):
    """
    Builds the face embedding model.

    Input:  112×112 RGB image, float32, range [0, 1]
    Output: 128-dim L2-normalised embedding vector
    Size after INT8 quantisation: ~3.5 MB
    """
    base_model = tf.keras.applications.MobileNetV2(
        input_shape=input_shape,
        include_top=False,
        weights='imagenet'
    )

    # Freeze low-level layers; fine-tune the upper layers
    for layer in base_model.layers[:100]:
        layer.trainable = False
    for layer in base_model.layers[100:]:
        layer.trainable = True

    inputs = tf.keras.Input(shape=input_shape, name='face_input')
    x = base_model(inputs, training=False)
    x = tf.keras.layers.GlobalAveragePooling2D(name='gap')(x)
    x = tf.keras.layers.Dense(512, name='dense_512')(x)
    x = tf.keras.layers.BatchNormalization(name='bn_512')(x)
    x = tf.keras.layers.ReLU(name='relu_512')(x)
    x = tf.keras.layers.Dropout(0.3, name='dropout')(x)
    x = tf.keras.layers.Dense(embedding_dim, name='embeddings')(x)
    embeddings = L2NormalizeLayer(name='l2_normalize')(x)   # ← no Lambda

    return tf.keras.Model(inputs, embeddings, name='face_embedder')


def build_training_model(embedding_model, num_classes):
    """Adds softmax head for training. Stripped off before mobile export."""
    inputs     = embedding_model.input
    embeddings = embedding_model.output
    outputs    = tf.keras.layers.Dense(
        num_classes, activation='softmax', name='classifier'
    )(embeddings)
    return tf.keras.Model(inputs, outputs, name='face_classifier')


def cosine_similarity(emb1, emb2):
    """Similarity between two L2-normalised embeddings. Range: -1 to 1."""
    return float(np.dot(emb1, emb2))


# ── Quick test ────────────────────────────────────────────────────────────────
if __name__ == '__main__':
    print("Building model...")
    model = build_embedding_model()
    model.summary()

    dummy = np.random.random((1, 112, 112, 3)).astype(np.float32)
    emb   = model.predict(dummy, verbose=0)
    print(f"\nEmbedding shape : {emb.shape}")
    print(f"L2 norm         : {np.linalg.norm(emb):.6f}  (should be ~1.0)")
    print("\n✅ embedding_model.py — OK")
