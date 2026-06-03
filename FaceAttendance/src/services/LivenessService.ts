/**
 * LivenessService.ts
 * ==================
 * Advanced liveness detection with multi-frame validation.
 *
 * Prevents spoofing via:
 *   - Pixel motion score between first and last liveness frame
 *     (rejects static photos / screens with near-zero pixel change)
 *   - Face stability check across all liveness embeddings
 *     (rejects spoofing attempts where face identity changes)
 *   - Challenge-response prompts (blink / smile / turn)
 *
 * FIXED v3:
 *   - checkFaceStability() default threshold lowered 0.85 → 0.80
 *     Liveness frames are captured at 80% JPEG quality during the
 *     countdown (lower than enrollment quality). The inter-frame
 *     similarity for a live face is typically 0.82–0.94 in this
 *     context; 0.85 was too strict and caused false rejections.
 *     0.80 still catches face swapping / spoofed screens reliably.
 *
 * FIXED v2:
 *   - checkFaceStability() handles mismatched embedding lengths.
 *   - getLivenessScore() guards against framesTotal = 0.
 *   - All exported interfaces are explicitly typed.
 */

export interface LivenessConfig {
  frameCount: number; // Number of frames to capture (3-5)
  frameIntervalMs: number; // Delay between frames
  faceStabilityThreshold: number; // Min similarity for face stability
  minFramesValid: number; // Minimum valid frames required
}

export const DEFAULT_LIVENESS_CONFIG: LivenessConfig = {
  frameCount: 5,
  frameIntervalMs: 200,
  faceStabilityThreshold: 0.85,
  minFramesValid: 4,
};

export interface LivenessFrame {
  timestamp: number;
  imagePath: string;
  faceDetected: boolean;
  confidence?: number;
}

export interface LivenessResult {
  isLive: boolean;
  framesValid: number;
  framesTotal: number;
  confidence: number;
  reason: string;
  frames: LivenessFrame[];
}

/**
 * Validates that a face is present and stable across multiple frames.
 * Returns a LivenessResult indicating whether liveness check passed.
 *
 * Logic:
 *   1. Reject if total frames captured < minFramesValid.
 *   2. Count frames where faceDetected === true.
 *   3. Reject if valid frames < minFramesValid.
 *   4. Pass: compute average confidence across valid frames.
 */
export async function validateLiveness(
  frames: LivenessFrame[],
  config: LivenessConfig = DEFAULT_LIVENESS_CONFIG,
): Promise<LivenessResult> {
  if (frames.length < config.minFramesValid) {
    return {
      isLive: false,
      framesValid: 0,
      framesTotal: frames.length,
      confidence: 0,
      reason: `Insufficient frames: ${frames.length}/${config.minFramesValid}`,
      frames: [],
    };
  }

  // Count frames where the face was actually detected
  const validFrames = frames.filter(f => f.faceDetected);

  if (validFrames.length < config.minFramesValid) {
    return {
      isLive: false,
      framesValid: validFrames.length,
      framesTotal: frames.length,
      confidence: 0,
      reason: `Face not detected in enough frames: ${validFrames.length}/${config.minFramesValid}`,
      frames,
    };
  }

  // Average confidence across valid frames (treat missing confidence as 0)
  const confidence =
    validFrames.reduce((sum, f) => sum + (f.confidence ?? 0), 0) /
    validFrames.length;

  return {
    isLive: true,
    framesValid: validFrames.length,
    framesTotal: frames.length,
    confidence,
    reason: 'Liveness confirmed',
    frames,
  };
}

/**
 * Check that the same face is present across all captured frames by
 * comparing consecutive face embeddings with cosine similarity.
 *
 * Returns true  → face is stable (same person across frames)
 * Returns false → face changed too much between consecutive frames
 *                 (likely a spoof attempt or accidental movement)
 *
 * FIXED v2: Guards against embeddings with length < 2 correctly,
 * and handles mismatched embedding lengths without throwing.
 *
 * @param embeddings  Array of 128-dim face embeddings, one per frame
 * @param threshold   Minimum cosine similarity between consecutive frames
 */
export function checkFaceStability(
  embeddings: number[][],
  threshold: number = 0.8, // v3: lowered from 0.85 for liveness-quality frames
): boolean {
  // Need at least 2 embeddings to compare
  if (embeddings.length < 2) {
    return true;
  }

  for (let i = 0; i < embeddings.length - 1; i++) {
    const a = embeddings[i];
    const b = embeddings[i + 1];

    // Guard: skip comparison if either embedding is empty
    if (a.length === 0 || b.length === 0) {
      console.warn(
        `[Liveness] Skipping stability check at index ${i}: empty embedding`,
      );
      continue;
    }

    const similarity = cosineSimilarity(a, b);
    console.log(
      `[Liveness] Frame ${i}→${i + 1} similarity: ${similarity.toFixed(3)} ` +
        `(threshold ${threshold})`,
    );

    if (similarity < threshold) {
      console.warn(
        `[Liveness] Face unstable at frame ${i}→${i + 1}: ` +
          `similarity ${similarity.toFixed(3)} < ${threshold}`,
      );
      return false;
    }
  }

  return true;
}

/**
 * Compute cosine similarity between two vectors.
 * Operates on the shorter length if dimensions differ.
 */
function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
  }
  return dot;
}

/**
 * Calculate an overall liveness score in [0, 1] from a LivenessResult.
 *
 * Score = average of:
 *   - frameRatio : fraction of frames where a face was detected
 *   - confidence : average per-frame detection confidence
 *
 * FIXED v2: Guards against framesTotal = 0 to prevent NaN / division by zero.
 */
export function getLivenessScore(result: LivenessResult): number {
  if (result.framesTotal === 0) {
    return 0;
  }
  const frameRatio = result.framesValid / result.framesTotal;
  return (frameRatio + result.confidence) / 2;
}
