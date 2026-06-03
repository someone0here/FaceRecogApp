"""
setup_dataset.py
================
Helps you build a face dataset for training.

TWO OPTIONS:
  A) Capture your own faces using your Mac webcam  ← FASTEST for hackathon demo
  B) Download LFW (Labeled Faces in the Wild)      ← Larger, pre-built dataset

For a hackathon DEMO, Option A is actually better — you can enroll yourself
and 2-3 colleagues in 2 minutes and show the system working live.

For accuracy BENCHMARKING, Option B gives you more diverse data.

Run from: ~/FaceRecogApp/ai_model/
Commands:
  python3 setup_dataset.py --capture   # Option A — webcam capture
  python3 setup_dataset.py --download  # Option B — download LFW
  python3 setup_dataset.py --status    # Check what's in dataset/ already
"""

import os
import sys
import cv2
import time
import argparse
import numpy as np
import mediapipe as mp
import urllib.request
import tarfile
from pathlib import Path


DATASET_DIR   = './dataset'
FRAMES_TARGET = 40     # Capture 40 photos per person (enough for training)


# ── Option A: Webcam capture ─────────────────────────────────────────────────

def capture_faces_webcam(person_name, num_frames=FRAMES_TARGET):
    """
    Capture face photos from your Mac webcam.

    How it works:
    - Opens webcam, auto-detects your face using MediaPipe
    - Saves a photo every 0.5 seconds when a face is detected
    - Automatically varies the frame (asks you to move slightly)
    - Stops after num_frames are collected
    """
    person_dir = os.path.join(DATASET_DIR, person_name)
    os.makedirs(person_dir, exist_ok=True)

    # Check existing images
    existing = len(list(Path(person_dir).glob('*.jpg')))
    if existing >= num_frames:
        print(f"  {person_name} already has {existing} images. Skipping.")
        return existing

    print(f"\n📸 Capturing {num_frames} photos for: {person_name}")
    print("  ▸ Look at the camera")
    print("  ▸ Slowly move your head left/right/up/down during capture")
    print("  ▸ Try different expressions (neutral, slight smile)")
    print("  ▸ Press 'q' to stop early\n")

    # MediaPipe face detection
    mp_fd    = mp.solutions.face_detection
    detector = mp_fd.FaceDetection(
        model_selection=0,
        min_detection_confidence=0.6
    )

    cap = cv2.VideoCapture(0)
    if not cap.isOpened():
        print("❌ Cannot open webcam.")
        print("   Go to: System Preferences → Security & Privacy → Camera")
        print("   Allow Terminal to access the camera, then retry.")
        return 0

    cap.set(cv2.CAP_PROP_FRAME_WIDTH,  640)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 480)

    saved        = existing
    last_save_t  = 0
    SAVE_INTERVAL = 0.5   # seconds between captures

    # Count-down before starting
    for i in [3, 2, 1]:
        ret, frame = cap.read()
        if ret:
            frame_disp = frame.copy()
            cv2.putText(frame_disp, f"Starting in {i}...",
                        (180, 240), cv2.FONT_HERSHEY_SIMPLEX,
                        1.5, (0, 200, 255), 3)
            cv2.imshow(f"Capturing: {person_name}", frame_disp)
            cv2.waitKey(1)
        time.sleep(1)

    while saved < num_frames:
        ret, frame = cap.read()
        if not ret:
            break

        # Detect face
        rgb     = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        results = detector.process(rgb)
        display = frame.copy()

        face_found = bool(results.detections)

        if face_found:
            det  = results.detections[0]
            bbox = det.location_data.relative_bounding_box
            h, w = frame.shape[:2]
            x1   = max(0, int(bbox.xmin * w))
            y1   = max(0, int(bbox.ymin * h))
            x2   = min(w, int((bbox.xmin + bbox.width) * w))
            y2   = min(h, int((bbox.ymin + bbox.height) * h))
            color = (0, 220, 0)
            cv2.rectangle(display, (x1, y1), (x2, y2), color, 2)

            # Auto-capture on interval
            now = time.time()
            if now - last_save_t >= SAVE_INTERVAL:
                img_path = os.path.join(person_dir,
                                        f"{person_name}_{saved:04d}.jpg")
                cv2.imwrite(img_path, frame)
                saved      += 1
                last_save_t = now
        else:
            color = (0, 0, 200)

        # Progress bar
        progress = int((saved / num_frames) * 300)
        cv2.rectangle(display, (10, 10), (310, 30), (50, 50, 50), -1)
        cv2.rectangle(display, (10, 10), (10 + progress, 30), (0, 200, 0), -1)
        cv2.putText(display, f"{saved}/{num_frames} captured",
                    (10, 50), cv2.FONT_HERSHEY_SIMPLEX,
                    0.65, (255, 255, 255), 2)

        status = "FACE DETECTED" if face_found else "Move closer / better lighting"
        cv2.putText(display, status, (10, display.shape[0] - 10),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.55, color, 2)

        cv2.imshow(f"Capturing: {person_name}", display)
        if cv2.waitKey(1) & 0xFF == ord('q'):
            break

    cap.release()
    cv2.destroyAllWindows()
    print(f"  ✅ Saved {saved} images to {person_dir}/")
    return saved


def run_capture_wizard():
    """Interactive wizard to capture faces for multiple people."""
    print("\n" + "=" * 50)
    print("  FACE DATASET CAPTURE WIZARD")
    print("=" * 50)
    print("\nThis will capture face photos for each person you want")
    print("the system to recognise.\n")
    print("Minimum: 2 people, 10 photos each")
    print("Recommended for hackathon: 3-5 people, 40 photos each\n")

    people = []
    while True:
        name = input("Enter person's name (or press Enter to finish): ").strip()
        if not name:
            break
        # Sanitise name for use as folder name
        safe_name = name.replace(' ', '_').replace('/', '_')
        people.append(safe_name)
        print(f"  Added: {safe_name}")

    if len(people) < 2:
        print("\n⚠️  Need at least 2 people for face recognition training.")
        if not people:
            return
        print("  Please run the script again and add more people.")

    print(f"\nWill capture photos for: {', '.join(people)}")
    confirm = input("Ready? (y/n): ").strip().lower()
    if confirm != 'y':
        print("Cancelled.")
        return

    total_saved = 0
    for person in people:
        n = capture_faces_webcam(person)
        total_saved += n

    print(f"\n✅ Dataset capture complete!")
    print(f"   Total images saved: {total_saved}")
    print(f"   Dataset location  : {os.path.abspath(DATASET_DIR)}")
    print(f"\nNext step: Run training")
    print(f"  cd src && python3 train.py")


# ── Option B: Download LFW ────────────────────────────────────────────────────

def download_lfw():
    """
    Download LFW (Labeled Faces in the Wild) dataset.
    LFW contains 13,000 images of 5,749 people.
    We use a subset filtered to people with ≥20 images (1,680 people).

    File size: ~173 MB download, ~230 MB extracted.

    ⚠️  IMPORTANT — DEMOGRAPHICS NOTE:
      LFW is predominantly Caucasian faces (sourced from news/media).
      The hackathon requires >95% accuracy on INDIAN demographics.
      LFW alone does NOT satisfy this requirement.

      For a complete submission:
        1. Use --capture to add real Indian faces to your dataset/
        2. LFW can supplement with more variety, but is not sufficient alone
        3. Aim for at least 5 Indian people with 20+ photos each
           in addition to whatever LFW provides

      The augmentation pipeline (dataset_loader.py) simulates Indian outdoor
      lighting conditions, but the base face data must be Indian.
    """
    LFW_URL   = "http://vis-www.cs.umass.edu/lfw/lfw.tgz"
    LFW_TGZ   = "./lfw.tgz"
    LFW_DIR   = "./lfw"

    print("\nDownloading LFW dataset (~173 MB)...")
    print("This may take 3-10 minutes depending on your connection.\n")

    if not os.path.exists(LFW_TGZ):
        def progress(block_num, block_size, total_size):
            downloaded = block_num * block_size
            pct        = min(downloaded / total_size * 100, 100)
            bar_len    = 40
            filled     = int(bar_len * pct / 100)
            bar        = '█' * filled + '░' * (bar_len - filled)
            print(f"\r  [{bar}] {pct:.1f}%  "
                  f"{downloaded/1024/1024:.1f}/{total_size/1024/1024:.1f} MB",
                  end='', flush=True)

        urllib.request.urlretrieve(LFW_URL, LFW_TGZ, reporthook=progress)
        print("\n  ✅ Download complete")
    else:
        print("  lfw.tgz already exists, skipping download")

    if not os.path.exists(LFW_DIR):
        print("  Extracting...")
        with tarfile.open(LFW_TGZ, 'r:gz') as tar:
            tar.extractall('.')
        print("  ✅ Extracted to ./lfw/")

    # Reorganise into our dataset/ structure
    # Only keep people with ≥ 20 images (better training signal)
    print(f"\n  Building dataset/ from LFW (keeping people with ≥20 images)...")
    os.makedirs(DATASET_DIR, exist_ok=True)

    lfw_path   = Path(LFW_DIR) / 'lfw'
    if not lfw_path.exists():
        lfw_path = Path(LFW_DIR)

    copied      = 0
    people_kept = 0
    MIN_IMGS    = 20

    for person_dir in sorted(lfw_path.iterdir()):
        if not person_dir.is_dir():
            continue
        imgs = list(person_dir.glob('*.jpg'))
        if len(imgs) < MIN_IMGS:
            continue

        dest = Path(DATASET_DIR) / person_dir.name
        dest.mkdir(exist_ok=True)

        for img_path in imgs:
            dst_path = dest / img_path.name
            if not dst_path.exists():
                import shutil
                shutil.copy2(img_path, dst_path)
            copied += 1

        people_kept += 1

    print(f"  ✅ Copied {copied} images for {people_kept} people")
    print(f"     Dataset → {os.path.abspath(DATASET_DIR)}")
    print(f"\n  ⚠️  DEMOGRAPHICS WARNING:")
    print(f"  LFW is mostly Caucasian faces and does NOT satisfy the")
    print(f"  hackathon's Indian demographics requirement on its own.")
    print(f"  Run: python3 setup_dataset.py --capture")
    print(f"  to add Indian faces alongside the LFW data.")


# ── Status check ─────────────────────────────────────────────────────────────

def print_status():
    """Print a summary of what's currently in the dataset/ folder."""
    print("\n" + "=" * 50)
    print("  DATASET STATUS")
    print("=" * 50)

    if not os.path.exists(DATASET_DIR):
        print(f"\n  dataset/ folder does not exist yet.")
        print(f"  Run:  python3 setup_dataset.py --capture")
        return

    person_dirs = sorted([d for d in Path(DATASET_DIR).iterdir() if d.is_dir()])
    if not person_dirs:
        print(f"\n  dataset/ is empty. No person folders found.")
        return

    total_images = 0
    print(f"\n  {'Person':<30} {'Images':>8}  {'Status'}")
    print("  " + "-" * 55)

    for pd in person_dirs:
        imgs = (list(pd.glob('*.jpg'))  +
                list(pd.glob('*.jpeg')) +
                list(pd.glob('*.png')))
        n    = len(imgs)
        total_images += n
        if n >= 20:
            status = "✅ good"
        elif n >= 5:
            status = "⚠️  OK (add more for better accuracy)"
        else:
            status = "❌ too few — need at least 5"
        print(f"  {pd.name:<30} {n:>8}   {status}")

    print("  " + "-" * 55)
    print(f"  {'TOTAL':<30} {total_images:>8} images, {len(person_dirs)} people")

    ready_for_training = len(person_dirs) >= 2 and all(
        len(list(pd.glob('*.jpg')) +
            list(pd.glob('*.jpeg')) +
            list(pd.glob('*.png'))) >= 5
        for pd in person_dirs
    )

    print(f"\n  Ready to train: {'✅ YES' if ready_for_training else '❌ NO'}")
    if ready_for_training:
        print("  Next step: cd src && python3 train.py")
    print()


# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == '__main__':
    parser = argparse.ArgumentParser(
        description='Face dataset setup for hackathon project'
    )
    grp = parser.add_mutually_exclusive_group()
    grp.add_argument('--capture',  action='store_true',
                     help='Capture faces from webcam (recommended)')
    grp.add_argument('--download', action='store_true',
                     help='Download LFW dataset')
    grp.add_argument('--status',   action='store_true',
                     help='Show current dataset status')
    args = parser.parse_args()

    if args.capture:
        run_capture_wizard()
    elif args.download:
        download_lfw()
    elif args.status:
        print_status()
    else:
        # No flag — show menu
        print("\n" + "=" * 50)
        print("  DATASET SETUP")
        print("=" * 50)
        print("\nOptions:")
        print("  python3 setup_dataset.py --capture   Webcam capture (fast, best for demo)")
        print("  python3 setup_dataset.py --download  Download LFW dataset (~173 MB)")
        print("  python3 setup_dataset.py --status    Check dataset status")
        print()
        print_status()
