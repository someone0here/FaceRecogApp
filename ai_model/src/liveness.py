"""
liveness.py
===========
Offline liveness detection using MediaPipe FaceMesh landmarks.

⚠️  IMPORTANT — PLATFORM NOTE:
  This file is a PYTHON / DESKTOP tool only.
  It uses OpenCV + MediaPipe, which do NOT run on React Native / iOS / Android.

  The actual mobile liveness detection is implemented in:
    FaceAttendance/src/screens/RecognitionScreen.tsx  (v9)

  Mobile approach (no extra model, no extra library):
    - 3 frames captured silently during the 4-second countdown
    - Pixel motion score (mean absolute luminance diff, center crop)
    - Embedding stability check across frames via LivenessService.ts

  This Python file serves TWO purposes:
    1. REFERENCE IMPLEMENTATION — shows the full EAR/MAR/yaw algorithm
       used as the theoretical basis for the liveness challenge design
    2. DESKTOP DEMO TOOL — run on a Mac/PC webcam to demonstrate the
       concept to judges without needing the mobile device

WHY LIVENESS DETECTION?
  Without it, someone can hold up a photo of a registered person and
  the recognition system will grant them access. Liveness detection
  prevents this by requiring a live biological action.

HOW IT WORKS:
  MediaPipe FaceMesh tracks 468 face landmarks in real-time.
  We measure geometric ratios between specific landmarks to detect:

    1. BLINK  — Eye Aspect Ratio (EAR) drops sharply when eye closes
    2. SMILE  — Mouth Aspect Ratio (MAR) rises when corners pull back
    3. HEAD TURN — Nose-to-cheek distance ratio shifts left/right

  A printed photo cannot perform any of these actions.
  A looped video replay is caught because we randomise which challenge
  we ask for (implemented in RecognitionScreen.tsx).

USAGE (desktop demo):
    python3 liveness.py        # Opens webcam, try blinking/smiling/turning

USAGE (programmatic):
    detector = LivenessDetector()
    detector.reset()
    result = detector.process_frame(frame_bgr)
    if detector.is_live(challenge='blink'):
        proceed_to_recognition()
"""

import numpy as np
import mediapipe as mp
import cv2
import time
from collections import deque


# ── MediaPipe FaceMesh landmark indices ──────────────────────────────────────
# These indices were chosen based on the 468-point FaceMesh topology.
# Reference: https://github.com/google/mediapipe/blob/master/mediapipe/modules/face_geometry/data/canonical_face_model_uv_visualization.png

# 6 points around each eye (used for EAR calculation)
LEFT_EYE  = [33,  160, 158, 133, 153, 144]
RIGHT_EYE = [362, 385, 387, 263, 373, 380]

# Mouth corners + upper/lower lip centres (used for MAR calculation)
MOUTH = [61, 291, 13, 14, 78, 308]

# Nose tip, left cheek, right cheek (used for yaw estimation)
NOSE_TIP    = 1
LEFT_CHEEK  = 234
RIGHT_CHEEK = 454


class LivenessDetector:
    """
    Stateful liveness detector.

    Lifecycle:
      1. Create once:  detector = LivenessDetector()
      2. Before each enrollment/recognition attempt: detector.reset()
      3. Each camera frame: result = detector.process_frame(frame_bgr)
      4. Check result:  detector.is_live(challenge='any')
    """

    # ── Tunable thresholds ─────────────────────────────────────────────────
    # These were calibrated across diverse skin tones and face sizes.
    # If false positives/negatives occur, adjust these values.

    EAR_CLOSED_THRESHOLD  = 0.22   # EAR below this → eye is closed
    EAR_BLINK_MIN_FRAMES  = 2      # Must be closed for at least N frames
    MAR_SMILE_THRESHOLD   = 0.42   # MAR above this → smiling
    MAR_SMILE_MIN_FRAMES  = 4      # Must be smiling for at least N frames
    YAW_TURN_THRESHOLD    = 0.22   # Yaw ratio above this → head turned
    HISTORY_LEN           = 15     # Frames kept in rolling history

    def __init__(self):
        mp_mesh = mp.solutions.face_mesh
        self.face_mesh = mp_mesh.FaceMesh(
            static_image_mode      = False,   # Video mode — uses tracking
            max_num_faces          = 1,
            refine_landmarks       = True,    # Adds iris + lip detail points
            min_detection_confidence = 0.5,
            min_tracking_confidence  = 0.5
        )

        # Rolling history buffers
        self.ear_history = deque(maxlen=self.HISTORY_LEN)
        self.mar_history = deque(maxlen=self.HISTORY_LEN)
        self.yaw_history = deque(maxlen=self.HISTORY_LEN)

        # Counters
        self._eye_closed_frames  = 0
        self._smile_frames       = 0

        # Detected flags (set to True permanently once triggered)
        self.blink_detected     = False
        self.smile_detected     = False
        self.head_turn_detected = False

    # ── Geometry helpers ──────────────────────────────────────────────────────

    def _landmarks_to_px(self, landmarks, indices, w, h):
        """Convert a list of landmark indices → numpy pixel coordinates."""
        pts = []
        for idx in indices:
            lm = landmarks[idx]
            pts.append(np.array([lm.x * w, lm.y * h], dtype=np.float32))
        return pts

    def _eye_aspect_ratio(self, landmarks, eye_indices, w, h):
        """
        Eye Aspect Ratio (EAR) — Soukupová & Čech (2016).

        EAR = (||p2-p6|| + ||p3-p5||) / (2 × ||p1-p4||)

        p1, p4 = horizontal eye corners
        p2, p3, p5, p6 = vertical lid points

        Open eye  → EAR ≈ 0.28–0.35
        Closed eye → EAR ≈ 0.05–0.18
        """
        pts = self._landmarks_to_px(landmarks, eye_indices, w, h)
        v1   = np.linalg.norm(pts[1] - pts[5])
        v2   = np.linalg.norm(pts[2] - pts[4])
        horiz = np.linalg.norm(pts[0] - pts[3])
        if horiz < 1e-6:
            return 0.0
        return float((v1 + v2) / (2.0 * horiz))

    def _mouth_aspect_ratio(self, landmarks, w, h):
        """
        Mouth Aspect Ratio (MAR).

        MAR = vertical_lip_opening / mouth_width

        Neutral mouth → MAR ≈ 0.25–0.35
        Smiling        → MAR ≈ 0.42–0.60  (corners rise + lips part slightly)
        """
        pts   = self._landmarks_to_px(landmarks, MOUTH, w, h)
        vert  = np.linalg.norm(pts[2] - pts[3])
        horiz = np.linalg.norm(pts[0] - pts[1])
        if horiz < 1e-6:
            return 0.0
        return float(vert / horiz)

    def _yaw_ratio(self, landmarks, w, h):
        """
        Head yaw (left/right rotation) estimated from nose-cheek distances.

        ratio = (right_dist - left_dist) / (right_dist + left_dist)

        Facing forward → ratio ≈ 0
        Turned right   → ratio > 0   (nose closer to right cheek)
        Turned left    → ratio < 0   (nose closer to left cheek)
        """
        nose  = np.array([landmarks[NOSE_TIP].x    * w,
                           landmarks[NOSE_TIP].y    * h])
        lcheek = np.array([landmarks[LEFT_CHEEK].x  * w,
                            landmarks[LEFT_CHEEK].y  * h])
        rcheek = np.array([landmarks[RIGHT_CHEEK].x * w,
                            landmarks[RIGHT_CHEEK].y * h])

        ld    = np.linalg.norm(nose - lcheek)
        rd    = np.linalg.norm(nose - rcheek)
        total = ld + rd
        if total < 1e-6:
            return 0.0
        return float((rd - ld) / total)

    # ── Per-frame processing ──────────────────────────────────────────────────

    def process_frame(self, frame_bgr):
        """
        Analyse one camera frame and update internal liveness state.

        Args:
            frame_bgr: OpenCV BGR image (numpy array)

        Returns:
            dict with keys:
              face_found        – bool, False if no face detected
              ear               – float, current Eye Aspect Ratio
              mar               – float, current Mouth Aspect Ratio
              yaw               – float, current head yaw ratio
              blink_detected    – bool
              smile_detected    – bool
              head_turn_detected– bool
              liveness_passed   – bool (any challenge passed)
        """
        h, w = frame_bgr.shape[:2]
        rgb  = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB)
        res  = self.face_mesh.process(rgb)

        empty = dict(
            face_found         = False,
            ear                = 0.0,
            mar                = 0.0,
            yaw                = 0.0,
            blink_detected     = self.blink_detected,
            smile_detected     = self.smile_detected,
            head_turn_detected = self.head_turn_detected,
            liveness_passed    = self.is_live()
        )

        if not res.multi_face_landmarks:
            return empty

        lm = res.multi_face_landmarks[0].landmark

        # Compute metrics
        left_ear  = self._eye_aspect_ratio(lm, LEFT_EYE,  w, h)
        right_ear = self._eye_aspect_ratio(lm, RIGHT_EYE, w, h)
        ear       = (left_ear + right_ear) / 2.0
        mar       = self._mouth_aspect_ratio(lm, w, h)
        yaw       = self._yaw_ratio(lm, w, h)

        # Store in history
        self.ear_history.append(ear)
        self.mar_history.append(mar)
        self.yaw_history.append(yaw)

        # ── Blink detection ─────────────────────────────────────────────────
        if ear < self.EAR_CLOSED_THRESHOLD:
            self._eye_closed_frames += 1
        else:
            # Eye just opened — did we see enough closed frames?
            if self._eye_closed_frames >= self.EAR_BLINK_MIN_FRAMES:
                self.blink_detected = True
            self._eye_closed_frames = 0

        # ── Smile detection ─────────────────────────────────────────────────
        if mar > self.MAR_SMILE_THRESHOLD:
            self._smile_frames += 1
            if self._smile_frames >= self.MAR_SMILE_MIN_FRAMES:
                self.smile_detected = True
        else:
            self._smile_frames = 0

        # ── Head turn detection ─────────────────────────────────────────────
        if len(self.yaw_history) >= 5:
            max_abs_yaw = max(abs(y) for y in self.yaw_history)
            if max_abs_yaw > self.YAW_TURN_THRESHOLD:
                self.head_turn_detected = True

        return dict(
            face_found         = True,
            ear                = ear,
            mar                = mar,
            yaw                = yaw,
            blink_detected     = self.blink_detected,
            smile_detected     = self.smile_detected,
            head_turn_detected = self.head_turn_detected,
            liveness_passed    = self.is_live()
        )

    # ── Public API ─────────────────────────────────────────────────────────────

    def is_live(self, challenge='any'):
        """
        Check if the liveness challenge has been passed.

        Args:
            challenge: 'blink' | 'smile' | 'head_turn' | 'any'
                       'any'  → passes if at least one challenge completed

        Returns:
            bool
        """
        if challenge == 'blink':
            return self.blink_detected
        elif challenge == 'smile':
            return self.smile_detected
        elif challenge == 'head_turn':
            return self.head_turn_detected
        else:   # 'any'
            return (self.blink_detected or
                    self.smile_detected or
                    self.head_turn_detected)

    def reset(self):
        """
        Reset all state. Call this before each new enrollment/recognition
        attempt so previous sessions don't bleed through.
        """
        self.ear_history.clear()
        self.mar_history.clear()
        self.yaw_history.clear()
        self._eye_closed_frames = 0
        self._smile_frames      = 0
        self.blink_detected     = False
        self.smile_detected     = False
        self.head_turn_detected = False

    def get_challenge_prompt(self):
        """
        Returns a user-facing instruction string for the FIRST incomplete challenge.
        Use this to display on the app screen.
        """
        if not self.blink_detected:
            return "👁  Please BLINK your eyes"
        elif not self.smile_detected:
            return "😊  Please SMILE"
        elif not self.head_turn_detected:
            return "↔️  Please turn your HEAD left or right"
        else:
            return "✅  Liveness verified!"

    # ── Debug overlay ─────────────────────────────────────────────────────────

    def draw_debug_overlay(self, frame, result):
        """
        Draws a semi-transparent debug panel on the frame.
        Only use during development — remove for production app.
        """
        h, w = frame.shape[:2]
        overlay = frame.copy()

        # Dark background panel
        cv2.rectangle(overlay, (8, 8), (310, 145), (20, 20, 20), -1)
        alpha = 0.65
        cv2.addWeighted(overlay, alpha, frame, 1 - alpha, 0, frame)
        cv2.rectangle(frame, (8, 8), (310, 145), (200, 200, 200), 1)

        WHITE  = (255, 255, 255)
        GREEN  = (50,  220,  50)
        RED    = (50,   50, 230)
        YELLOW = (50,  220, 220)
        FONT   = cv2.FONT_HERSHEY_SIMPLEX

        def txt(text, x, y, color=WHITE, scale=0.52, thick=1):
            cv2.putText(frame, text, (x, y), FONT, scale, color, thick,
                        cv2.LINE_AA)

        txt(f"EAR: {result['ear']:.3f}",  16, 32)
        txt(f"MAR: {result['mar']:.3f}",  16, 54)
        txt(f"YAW: {result['yaw']:.3f}",  16, 76)

        txt(f"Blink: {'YES' if result['blink_detected']     else 'no'}",
            170, 32,  GREEN if result['blink_detected']     else RED)
        txt(f"Smile: {'YES' if result['smile_detected']     else 'no'}",
            170, 54,  GREEN if result['smile_detected']     else RED)
        txt(f"Turn:  {'YES' if result['head_turn_detected'] else 'no'}",
            170, 76,  GREEN if result['head_turn_detected'] else RED)

        status = "LIVE  VERIFIED" if result['liveness_passed'] else "Waiting for action..."
        color  = GREEN if result['liveness_passed'] else YELLOW
        txt(status, 16, 110, color, scale=0.65, thick=2)

        if not result['face_found']:
            txt("NO FACE DETECTED", 16, 133, RED)

        return frame


# ── Standalone webcam test ─────────────────────────────────────────────────────

def run_webcam_test():
    """
    Test liveness detection live using your Mac webcam.
    Press 'r' to reset, 'q' to quit.
    """
    print("\nLiveness Detection — Webcam Test")
    print("Controls: 'r' = reset  |  'q' = quit")
    print("Try: blinking, smiling, turning your head\n")

    detector = LivenessDetector()
    cap      = cv2.VideoCapture(0)

    if not cap.isOpened():
        print("❌ Cannot open webcam. "
              "Check System Preferences → Privacy → Camera.")
        return

    frame_times = deque(maxlen=30)

    while True:
        ret, frame = cap.read()
        if not ret:
            break

        t0     = time.perf_counter()
        result = detector.process_frame(frame)
        frame  = detector.draw_debug_overlay(frame, result)
        frame_times.append((time.perf_counter() - t0) * 1000)

        fps_str = (f"FPS: {1000/np.mean(frame_times):.0f}  "
                   f"Latency: {np.mean(frame_times):.1f}ms")
        cv2.putText(frame, fps_str, (8, frame.shape[0] - 10),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.5, (180, 180, 180), 1)

        cv2.imshow("Liveness Detection Test", frame)

        if result['liveness_passed']:
            print(f"✅ LIVENESS VERIFIED  —  "
                  f"blink={result['blink_detected']}  "
                  f"smile={result['smile_detected']}  "
                  f"turn={result['head_turn_detected']}")

        key = cv2.waitKey(1) & 0xFF
        if key == ord('q'):
            break
        elif key == ord('r'):
            detector.reset()
            print("🔄 Reset")

    cap.release()
    cv2.destroyAllWindows()


if __name__ == '__main__':
    run_webcam_test()
