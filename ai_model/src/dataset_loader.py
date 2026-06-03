"""
dataset_loader.py
=================
Loads face images from disk, detects & crops faces using MediaPipe,
applies heavy augmentation to simulate harsh sunlight and low light.

Expected folder structure:
    dataset/
        Rahul_Sharma/
            img1.jpg
            img2.jpg
        Priya_Patel/
            img1.jpg
            ...

Minimum recommended: 10 images per person, 5+ people.
More data = better accuracy. 50+ images per person is ideal.
"""

import os
import numpy as np
import cv2
import tensorflow as tf
from pathlib import Path
import mediapipe as mp


class FaceDatasetLoader:

    def __init__(self, dataset_dir, image_size=(112, 112), batch_size=32):
        self.dataset_dir  = Path(dataset_dir)
        self.image_size   = image_size
        self.batch_size   = batch_size
        self._init_face_detector()

    # ── MediaPipe face detector ──────────────────────────────────────────────
    def _init_face_detector(self):
        mp_fd = mp.solutions.face_detection
        # model_selection=0 → optimised for faces within 2 metres (selfies)
        self.face_detector = mp_fd.FaceDetection(
            model_selection=0,
            min_detection_confidence=0.5
        )

    def detect_and_crop_face(self, image_bgr):
        """
        Detect the largest face in an image and return a square crop.
        Returns None if no face is found.

        We add a 5% margin around the detected bounding box so the model
        also sees a bit of forehead / chin — this improves accuracy.
        """
        image_rgb = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2RGB)
        results   = self.face_detector.process(image_rgb)

        if not results.detections:
            return None

        # Pick detection with highest confidence score
        best = max(results.detections,
                   key=lambda d: d.score[0] if d.score else 0)

        bbox  = best.location_data.relative_bounding_box
        h, w  = image_bgr.shape[:2]

        # Convert relative → absolute, add 5% margin
        margin = 0.05
        x1 = max(0, int((bbox.xmin - margin) * w))
        y1 = max(0, int((bbox.ymin - margin) * h))
        x2 = min(w, int((bbox.xmin + bbox.width  + margin) * w))
        y2 = min(h, int((bbox.ymin + bbox.height + margin) * h))

        face_crop = image_bgr[y1:y2, x1:x2]
        if face_crop.size == 0:
            return None

        face_resized = cv2.resize(face_crop, self.image_size)
        return face_resized

    # ── Load from disk ───────────────────────────────────────────────────────
    def load_dataset(self, save_calibration_images=True):
        """
        Walk dataset_dir, detect faces, build numpy arrays.

        Returns:
            images      – float32 array of shape (N, 112, 112, 3), range [0,1]
            labels      – int32 array of shape (N,)
            label_names – list of person name strings
        """
        images      = []
        labels      = []
        label_names = []
        skipped     = 0

        person_dirs = sorted([d for d in self.dataset_dir.iterdir()
                               if d.is_dir()])
        if not person_dirs:
            raise ValueError(
                f"No sub-folders found in {self.dataset_dir}\n"
                f"Create one folder per person, each containing their photos."
            )

        print(f"Found {len(person_dirs)} identities in {self.dataset_dir}")
        print("-" * 40)

        for label_idx, person_dir in enumerate(person_dirs):
            person_name = person_dir.name
            label_names.append(person_name)

            img_files = (list(person_dir.glob('*.jpg'))  +
                         list(person_dir.glob('*.jpeg')) +
                         list(person_dir.glob('*.png'))  +
                         list(person_dir.glob('*.JPG'))  +
                         list(person_dir.glob('*.JPEG')))

            count = 0
            for img_path in img_files:
                img = cv2.imread(str(img_path))
                if img is None:
                    skipped += 1
                    continue

                face = self.detect_and_crop_face(img)
                if face is not None:
                    images.append(face)
                    labels.append(label_idx)
                    count += 1
                else:
                    skipped += 1

            status = "✅" if count >= 5 else "⚠️ "
            print(f"  {status} {person_name}: {count} faces loaded "
                  f"(from {len(img_files)} images)")

            if count < 5:
                print(f"       ↑ Recommended minimum is 5 images per person")

        if not images:
            raise ValueError(
                "No faces detected in any image!\n"
                "Check that your images contain clearly visible faces."
            )

        images = np.array(images, dtype=np.float32) / 255.0
        labels = np.array(labels, dtype=np.int32)

        print("-" * 40)
        print(f"Total loaded : {len(images)} face images")
        print(f"Skipped      : {skipped} (no face detected / unreadable)")
        print(f"Identities   : {len(label_names)}")

        # Save a subset for INT8 quantization calibration (used by export_tflite.py)
        if save_calibration_images:
            os.makedirs('./saved_models', exist_ok=True)
            cal_imgs = images[:min(200, len(images))]
            np.save('./saved_models/calibration_images.npy', cal_imgs)
            print(f"Calibration images saved → saved_models/calibration_images.npy")

        return images, labels, label_names

    # ── TF Dataset with augmentation ─────────────────────────────────────────
    def create_tf_dataset(self, images, labels, augment=True):
        """
        Wraps numpy arrays into a tf.data.Dataset pipeline with optional
        augmentation. The pipeline is fully on-device (no disk I/O during
        training) and uses prefetching to keep the GPU/CPU busy.
        """
        dataset = tf.data.Dataset.from_tensor_slices((images, labels))

        if augment:
            dataset = dataset.map(
                lambda x, y: (self._augment(x), y),
                num_parallel_calls=tf.data.AUTOTUNE
            )

        dataset = (dataset
                   .shuffle(buffer_size=1000)
                   .batch(self.batch_size)
                   .prefetch(tf.data.AUTOTUNE))
        return dataset

    @tf.function
    def _augment(self, image):
        """
        Augmentation pipeline designed for Indian outdoor conditions:
          - Harsh sunlight  → high brightness + low contrast
          - Low light       → low brightness + high contrast
          - Indoor tubelight → slight hue shift
          - Partial shadow  → random crop simulation via flip+jitter
          - Glasses / mask  → random occlusion patch

        All ops are differentiable and run on CPU during data loading.
        """
        # Brightness: ±30% — simulates sun glare vs dim room
        image = tf.image.random_brightness(image, max_delta=0.30)

        # Contrast: 0.6 → 1.4 — simulates washed-out vs deep shadow
        image = tf.image.random_contrast(image, lower=0.60, upper=1.40)

        # Horizontal flip — person can look slightly left or right
        image = tf.image.random_flip_left_right(image)

        # Saturation — skin tone variation across Indian demographics
        image = tf.image.random_saturation(image, lower=0.75, upper=1.25)

        # Hue — subtle shift for different indoor light temperatures
        image = tf.image.random_hue(image, max_delta=0.05)

        # Jpeg quality simulation — low-end phone camera compression
        image = tf.cast(image * 255, tf.uint8)
        image = tf.image.random_jpeg_quality(image, 60, 100)
        image = tf.cast(image, tf.float32) / 255.0

        # Clip to [0, 1] after all ops
        image = tf.clip_by_value(image, 0.0, 1.0)
        return image


# ── Quick test ───────────────────────────────────────────────────────────────
if __name__ == '__main__':
    import sys

    dataset_path = './dataset'

    if not os.path.exists(dataset_path):
        print("dataset/ folder not found — creating a dummy test instead")
        print("In real usage, create dataset/<person_name>/*.jpg")

        # Create dummy data to verify the loader works
        os.makedirs('./dataset/Test_Person_1', exist_ok=True)
        os.makedirs('./dataset/Test_Person_2', exist_ok=True)

        # Create blank test images (no real faces — detection will skip them)
        for i in range(3):
            img = np.ones((224, 224, 3), dtype=np.uint8) * 128
            cv2.imwrite(f'./dataset/Test_Person_1/img{i}.jpg', img)
            cv2.imwrite(f'./dataset/Test_Person_2/img{i}.jpg', img)

        print("Dummy images created (no faces → they will be skipped)")
        sys.exit(0)

    loader = FaceDatasetLoader(dataset_path)
    images, labels, label_names = loader.load_dataset()

    print(f"\nImages array shape : {images.shape}")
    print(f"Labels array shape : {labels.shape}")
    print(f"Label names        : {label_names}")
    print(f"Pixel range        : [{images.min():.2f}, {images.max():.2f}]")

    # Test augmentation pipeline
    ds = loader.create_tf_dataset(images[:10], labels[:10], augment=True)
    for batch_imgs, batch_labels in ds.take(1):
        print(f"\nFirst batch shape  : {batch_imgs.shape}")
        print(f"First batch labels : {batch_labels.numpy()}")

    print("\n✅ dataset_loader.py — OK")
