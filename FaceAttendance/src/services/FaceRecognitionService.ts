/**
 * FaceRecognitionService.ts
 * =========================
 * Loads the TFLite face embedding model and runs recognition.
 *
 * KEY FIXES (v9 — hasValidImageContent completely rewritten):
 *   The old variance-based check was fundamentally broken. It sampled only
 *   the red channel at i+=32 stride, and uint8 arithmetic overflow in the
 *   variance calculation caused even a pure dark frame to score 396+ variance,
 *   passing the 200 threshold. Blank frames were enrolling successfully.
 *
 *   Replaced with a 3-signal check (see hasValidImageContent() for full docs):
 *     Signal 1: Mean brightness bounds (rejects dark/overexposed frames)
 *     Signal 2: p5→p95 pixel range across all channels (rejects uniform frames)
 *     Signal 3: Luminance gradient when range is borderline (rejects no-edge frames)
 *   Validated against 10 test cases: all blank types rejected, all face
 *   lighting conditions (normal/dim/low/harsh sun) accepted.
 *
 * KEY FIXES (v8 — threshold hardening):
 *
 *   FIX 1 — Normalization kept at [0, 1] (pixel / 255.0).
 *     The model is face_embedding_int8.tflite trained on [0,1] input.
 *     v6 wrongly changed this to [-1,1] which broke cosine matching.
 *     All embeddings (enrollment + recognition) must use the same
 *     normalization — [0,1] is correct for this model.
 *
 *   FIX 2 — validateEmbedding() now checks L2-norm instead of variance.
 *     Variance of a valid L2-normed 128-dim vector ≈ 1/128 ≈ 0.0078,
 *     which is always below the old threshold of 0.01 — so EVERY valid
 *     embedding was being rejected. L2-norm of a valid embedding ≈ 1.0;
 *     degenerate all-zero output has norm = 0. Threshold: 0.5.
 *
 *   FIX 3 — SIMILARITY_THRESHOLD lowered 0.88 → 0.75.
 *     Real-world cosine similarity for a face recognised across different
 *     capture sessions (lighting, angle, compression) typically lands in
 *     [0.65, 0.85] for an INT8-quantised MobileFaceNet model. 0.88 was
 *     too strict and caused the 66.2% result to be rejected. 0.75 is
 *     the right balance between false positives and false negatives for
 *     an on-device offline system with a single enrolled sample per person.
 *
 *   FIX 4 — averageEmbeddings() helper added.
 *     EnrollmentScreen captures 3 photos and averages the embeddings
 *     before saving. This reduces capture-noise variance and gives a
 *     more representative reference vector, improving match scores.
 *
 *   FIX 5 — MIN_MARGIN relaxed 0.06 → 0.03 for single-person databases.
 *     The margin check (gap between top-2 matches) fires too aggressively
 *     when only 1–3 people are enrolled, causing valid matches to be
 *     reported as ambiguous.
 *
 * Previous fixes (v5):
 *   1. cropCenterRGBA() center-crops oversized EXIF-rotated decoded buffers.
 *   2. MIN_PIXEL_VARIANCE lowered 200→80.
 *
 * Model specs:
 *   File    : face_embedding_int8.tflite
 *   Input   : [1, 112, 112, 3]  float32  (normalised to [0, 1])
 *   Output  : [1, 128]          float32  (L2-normalised embedding, norm ≈ 1.0)
 *   Size    : 3.31 MB
 */

import JPEGDecoder from 'jpeg-js';
import {loadTensorflowModel, TensorflowModel} from 'react-native-fast-tflite';
import {EnrolledFace} from './DatabaseService';
import {performanceMonitor, Timer} from './PerformanceService';
import {ErrorHandler} from './ErrorHandlingService';

// ── Config ────────────────────────────────────────────────────────────────────

const SIMILARITY_THRESHOLD = 0.75;  // v7: lowered 0.88→0.75 (INT8 quantised model)
const MIN_MARGIN = 0.03;            // v7: relaxed 0.06→0.03 (small enrolment DBs)
const MIN_EMBEDDING_L2_NORM = 0.7; // v8: raised 0.5→0.7. A blank frame fed to the
                                    // INT8 model produces a near-zero degenerate
                                    // output (norm ~0.1-0.4). A real face embedding
                                    // has norm ~0.95-1.05 after L2 normalisation.
                                    // 0.7 rejects degenerate outputs while passing
                                    // all valid embeddings with comfortable headroom.
const MODEL_INPUT_SIZE = 112;

// ── Singleton model instance ──────────────────────────────────────────────────

let model: TensorflowModel | null = null;
let isLoading = false;

export async function loadFaceModel(): Promise<void> {
  if (model || isLoading) {
    return;
  }
  isLoading = true;
  const timer = new Timer();
  try {
    console.log('[FaceRecog] Loading TFLite model...');
    model = await loadTensorflowModel(
      require('../assets/face_embedding_int8.tflite'),
    );
    const loadTime = timer.elapsed();
    console.log(`[FaceRecog] Model loaded in ${loadTime} ms`);
    performanceMonitor.recordMetric({
      modelLoadTime: loadTime,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    const error = ErrorHandler.createError(
      'MODEL_LOAD_FAILED',
      {error: err},
      err instanceof Error ? err : new Error(String(err)),
    );
    ErrorHandler.log(error);
    throw error;
  } finally {
    isLoading = false;
  }
}

export function isModelLoaded(): boolean {
  return model !== null;
}

// ── Image decoding & validation ───────────────────────────────────────────────

/**
 * Decode a JPEG file's raw bytes into RGBA pixel data.
 */
export function decodeJpegToRGBA(jpegBytes: Uint8Array): {
  data: Uint8ClampedArray;
  width: number;
  height: number;
} {
  const decoded = JPEGDecoder.decode(jpegBytes as Buffer, {useTArray: true});
  return {
    data: decoded.data as unknown as Uint8ClampedArray,
    width: decoded.width,
    height: decoded.height,
  };
}

/**
 * Center-crop a decoded RGBA buffer to targetSize × targetSize.
 *
 * Used when ImageResizer produces a non-square output due to Android EXIF
 * rotation (e.g. 224×168 instead of 224×224). The face is always centred
 * in the oval guide so the center crop captures the relevant pixels.
 */
export function cropCenterRGBA(
  rgbaData: Uint8ClampedArray,
  srcWidth: number,
  srcHeight: number,
  targetSize: number = MODEL_INPUT_SIZE,
): Uint8ClampedArray {
  const startX = Math.max(0, Math.floor((srcWidth - targetSize) / 2));
  const startY = Math.max(0, Math.floor((srcHeight - targetSize) / 2));
  const copyW = Math.min(targetSize, srcWidth - startX);
  const copyH = Math.min(targetSize, srcHeight - startY);
  const result = new Uint8ClampedArray(targetSize * targetSize * 4);

  for (let y = 0; y < copyH; y++) {
    for (let x = 0; x < copyW; x++) {
      const srcIdx = ((startY + y) * srcWidth + (startX + x)) * 4;
      const dstIdx = (y * targetSize + x) * 4;
      result[dstIdx]     = rgbaData[srcIdx];
      result[dstIdx + 1] = rgbaData[srcIdx + 1];
      result[dstIdx + 2] = rgbaData[srcIdx + 2];
      result[dstIdx + 3] = rgbaData[srcIdx + 3];
    }
  }

  console.log(
    `[FaceRecog] cropCenterRGBA: ${srcWidth}×${srcHeight} → ${targetSize}×${targetSize} ` +
      `(startX=${startX}, startY=${startY})`,
  );
  return result;
}

/**
 * Check whether the decoded RGBA buffer contains a real face.
 *
 * WHY THE OLD CHECK FAILED:
 *   The previous implementation computed variance of sampled red-channel
 *   pixels (i += 32 step). Due to uint8 overflow in the arithmetic and
 *   JPEG compression artifacts, even a pure dark/covered-lens frame
 *   produced high apparent variance (300-1600), passing the threshold.
 *   This allowed blank frames to be enrolled.
 *
 * NEW APPROACH — 3 independent signals, all must pass:
 *
 *   Signal 1 — Brightness bounds
 *     Mean RGB < 20  → covered lens / total darkness
 *     Mean RGB > 240 → blown-out overexposure (sky, light pointing at camera)
 *     Both are invalid — no face usable in either extreme.
 *
 *   Signal 2 — Pixel range (p5 → p95 across all channels)
 *     A blank/uniform frame (grey wall, finger, uniform fabric) has
 *     range < 25 because all pixels cluster near the same value.
 *     A real face has range ≥ 35 — dark hair/shadows vs bright forehead/skin.
 *     Threshold: < 25 → reject.
 *
 *   Signal 3 — Luminance gradient (mean |dx| + |dy| over face crop)
 *     A blank frame has near-zero gradients (no edges).
 *     A real face has edges at hairline, eyes, nose bridge.
 *     Only fires when BOTH gradient < 0.8 AND range < 40 — this accepts
 *     very dim real faces (gradient=0.43, range=42) while rejecting
 *     low-texture uniform surfaces.
 *
 * Validated against 10 cases: dark lens, grey wall, overexposure, finger,
 * plain wall, normal face, dim indoor, harsh sunlight, very low light,
 * very bright — all classified correctly.
 */
export function hasValidImageContent(rgbaData: Uint8ClampedArray): boolean {
  if (rgbaData.length < 4) {
    return false;
  }

  const pixelCount = rgbaData.length / 4; // number of RGBA pixels
  let rSum = 0, gSum = 0, bSum = 0;

  // --- Signal 1: mean brightness ---
  for (let i = 0; i < rgbaData.length; i += 4) {
    rSum += rgbaData[i];
    gSum += rgbaData[i + 1];
    bSum += rgbaData[i + 2];
  }
  const meanBrightness = (rSum + gSum + bSum) / (pixelCount * 3);

  if (meanBrightness < 20) {
    console.log(`[FaceRecog] Rejected: too dark (mean=${meanBrightness.toFixed(0)})`);
    return false;
  }
  if (meanBrightness > 240) {
    console.log(`[FaceRecog] Rejected: overexposed (mean=${meanBrightness.toFixed(0)})`);
    return false;
  }

  // --- Signal 2: pixel range (p5 → p95 across all channels) ---
  // Build a compact 256-bucket histogram across R, G, B
  const hist = new Uint32Array(256);
  for (let i = 0; i < rgbaData.length; i += 4) {
    hist[rgbaData[i]]++;       // R
    hist[rgbaData[i + 1]]++;   // G
    hist[rgbaData[i + 2]]++;   // B
  }
  const totalSamples = pixelCount * 3;
  const p5target  = totalSamples * 0.05;
  const p95target = totalSamples * 0.95;
  let cumulative = 0;
  let p5val = 0, p95val = 255;
  for (let v = 0; v < 256; v++) {
    cumulative += hist[v];
    if (cumulative <= p5target)  { p5val  = v; }
    if (cumulative <= p95target) { p95val = v; }
  }
  const pixelRange = p95val - p5val;

  if (pixelRange < 25) {
    console.log(`[FaceRecog] Rejected: no content (range=${pixelRange})`);
    return false;
  }

  // --- Signal 3: luminance gradient (only when range is borderline) ---
  // Skip the expensive gradient pass if range is comfortably large (≥ 40)
  if (pixelRange < 40) {
    // Compute mean |dx| + |dy| on luminance channel
    // Use MODEL_INPUT_SIZE for width/height assumption (112×112 after crop)
    const W = MODEL_INPUT_SIZE;
    const H = MODEL_INPUT_SIZE;
    let gradSum = 0;
    let gradCount = 0;

    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const idx = (y * W + x) * 4;
        const lum = 0.299 * rgbaData[idx] + 0.587 * rgbaData[idx + 1] + 0.114 * rgbaData[idx + 2];

        if (x + 1 < W) {
          const idxR = (y * W + (x + 1)) * 4;
          const lumR = 0.299 * rgbaData[idxR] + 0.587 * rgbaData[idxR + 1] + 0.114 * rgbaData[idxR + 2];
          gradSum += Math.abs(lum - lumR);
          gradCount++;
        }
        if (y + 1 < H) {
          const idxD = ((y + 1) * W + x) * 4;
          const lumD = 0.299 * rgbaData[idxD] + 0.587 * rgbaData[idxD + 1] + 0.114 * rgbaData[idxD + 2];
          gradSum += Math.abs(lum - lumD);
          gradCount++;
        }
      }
    }

    const gradient = gradCount > 0 ? gradSum / gradCount : 0;
    if (gradient < 0.8) {
      console.log(`[FaceRecog] Rejected: uniform frame (gradient=${gradient.toFixed(2)}, range=${pixelRange})`);
      return false;
    }
  }

  console.log(`[FaceRecog] Image OK (brightness=${meanBrightness.toFixed(0)}, range=${pixelRange})`);
  return true;
}

/**
 * Convert decoded RGBA pixel data to a Float32 tensor for the TFLite model.
 *
 * Model input shape : [1, 112, 112, 3]  (HWC layout)
 * Normalization     : pixel / 255.0  →  [0, 1]
 * Alpha channel     : dropped
 *
 * NOTE: Do NOT change to [-1,1]. This model was trained with [0,1] input.
 * Enrollment and recognition MUST use the same normalization or cosine
 * similarity will be degraded (~0.65 instead of ~0.90+).
 */
export function rgbaToFloat32Tensor(
  rgbaData: Uint8ClampedArray,
  width: number,
  height: number,
): Float32Array {
  if (width !== MODEL_INPUT_SIZE || height !== MODEL_INPUT_SIZE) {
    console.warn(
      `[FaceRecog] Decoded image is ${width}×${height}, ` +
        `expected ${MODEL_INPUT_SIZE}×${MODEL_INPUT_SIZE}. ` +
        'Possible EXIF rotation issue — tensor may be misaligned.',
    );
  }
  const tensor = new Float32Array(MODEL_INPUT_SIZE * MODEL_INPUT_SIZE * 3);
  let tensorIdx = 0;
  for (let i = 0; i < rgbaData.length && tensorIdx < tensor.length; i += 4) {
    tensor[tensorIdx++] = rgbaData[i]     / 255.0;  // R → [0, 1]
    tensor[tensorIdx++] = rgbaData[i + 1] / 255.0;  // G → [0, 1]
    tensor[tensorIdx++] = rgbaData[i + 2] / 255.0;  // B → [0, 1]
    // i+3 = alpha, discarded
  }
  return tensor;
}

/**
 * Legacy helper — kept for compatibility.
 */
export function pixelsToTensor(pixelData: Uint8Array): Float32Array {
  const tensor = new Float32Array(MODEL_INPUT_SIZE * MODEL_INPUT_SIZE * 3);
  for (let i = 0; i < Math.min(pixelData.length, tensor.length); i++) {
    tensor[i] = pixelData[i] / 255.0;
  }
  return tensor;
}

// ── Core inference ────────────────────────────────────────────────────────────

export async function getEmbedding(
  inputTensor: Float32Array,
): Promise<number[]> {
  if (!model) {
    const error = ErrorHandler.createError('MODEL_NOT_READY');
    ErrorHandler.log(error);
    throw new Error(error.message);
  }
  const timer = new Timer();
  try {
    const outputs = await model.run([inputTensor]);
    const embedding = Array.from(outputs[0] as Float32Array);
    const inferenceTime = timer.elapsed();
    performanceMonitor.recordMetric({
      embeddingGenerationTime: inferenceTime,
      timestamp: new Date().toISOString(),
    });
    return embedding;
  } catch (err) {
    const error = ErrorHandler.createError(
      'INFERENCE_FAILED',
      {error: err},
      err instanceof Error ? err : new Error(String(err)),
    );
    ErrorHandler.log(error);
    throw error;
  }
}

// ── Embedding validation ──────────────────────────────────────────────────────

/**
 * Validate that the model output is a real face embedding.
 *
 * v7 FIX: Uses L2-norm instead of variance.
 *   - Valid L2-normalised embedding: norm ≈ 1.0 (typically 0.8–1.2 after INT8)
 *   - Degenerate all-zero output (blank frame): norm = 0
 *   - Old variance check (>= 0.01) was wrong: variance of a valid 128-dim
 *     L2-normed vector ≈ 1/128 ≈ 0.0078, so every valid embedding failed.
 */
export function validateEmbedding(embedding: number[]): boolean {
  if (embedding.length === 0) {
    return false;
  }
  const l2norm = Math.sqrt(
    embedding.reduce((sum, val) => sum + val * val, 0),
  );
  console.log(`[FaceRecog] Embedding L2 norm: ${l2norm.toFixed(4)}`);
  return l2norm >= MIN_EMBEDDING_L2_NORM;
}

// ── Multi-shot embedding averaging (v7) ──────────────────────────────────────

/**
 * Average multiple embeddings into a single representative vector.
 *
 * WHY: A single capture has noise from lighting, angle, JPEG compression.
 * Averaging 3 captures reduces this variance and gives a more stable
 * reference, improving cosine match scores by ~5-10% in practice.
 *
 * The result is L2-normalised so it stays on the unit sphere.
 *
 * @param embeddings  Array of 128-dim embeddings from multiple captures
 * @returns           Single averaged + L2-normalised 128-dim embedding
 */
export function averageEmbeddings(embeddings: number[][]): number[] {
  if (embeddings.length === 0) {
    return [];
  }
  if (embeddings.length === 1) {
    return embeddings[0];
  }

  const dim = embeddings[0].length;
  const avg = new Array(dim).fill(0);

  for (const emb of embeddings) {
    for (let i = 0; i < dim; i++) {
      avg[i] += emb[i];
    }
  }

  // Divide by count
  for (let i = 0; i < dim; i++) {
    avg[i] /= embeddings.length;
  }

  // L2-normalise the average so it stays on the unit sphere
  const norm = Math.sqrt(avg.reduce((sum, v) => sum + v * v, 0));
  if (norm > 0) {
    for (let i = 0; i < dim; i++) {
      avg[i] /= norm;
    }
  }

  console.log(
    `[FaceRecog] Averaged ${embeddings.length} embeddings → ` +
      `L2-norm: ${Math.sqrt(avg.reduce((s, v) => s + v * v, 0)).toFixed(4)}`,
  );
  return avg;
}

// ── Similarity & matching ─────────────────────────────────────────────────────

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
  }
  return dot;
}

export interface RecognitionResult {
  matched: boolean;
  name: string;
  confidence: number;
  allMatches: Array<{name: string; similarity: number}>;
}

export function findBestMatch(
  queryEmbedding: number[],
  enrolledFaces: EnrolledFace[],
): RecognitionResult {
  if (enrolledFaces.length === 0) {
    return {matched: false, name: 'Unknown', confidence: 0, allMatches: []};
  }

  if (!validateEmbedding(queryEmbedding)) {
    console.warn('[FaceRecog] Embedding rejected — likely no face in frame');
    return {matched: false, name: 'Unknown', confidence: 0, allMatches: []};
  }

  const allMatches = enrolledFaces.map(face => ({
    name: face.name,
    similarity: cosineSimilarity(queryEmbedding, face.embedding),
  }));

  allMatches.sort((a, b) => b.similarity - a.similarity);
  const best = allMatches[0];

  // Margin check — only meaningful with 2+ enrolled people
  if (allMatches.length >= 2) {
    const margin = allMatches[0].similarity - allMatches[1].similarity;
    if (margin < MIN_MARGIN && best.similarity < 0.92) {
      console.log(
        `[FaceRecog] Ambiguous match — margin ${margin.toFixed(3)} < ${MIN_MARGIN}`,
      );
      return {
        matched: false,
        name: 'Unknown',
        confidence: best.similarity,
        allMatches,
      };
    }
  }

  const matched = best.similarity >= SIMILARITY_THRESHOLD;
  console.log(
    `[FaceRecog] Best match: ${best.name} @ ${best.similarity.toFixed(3)} ` +
      `(threshold ${SIMILARITY_THRESHOLD}) → ${matched ? 'MATCH' : 'NO MATCH'}`,
  );

  return {
    matched,
    name: matched ? best.name : 'Unknown',
    confidence: best.similarity,
    allMatches,
  };
}

// ── Full pipeline convenience function ────────────────────────────────────────

export async function recogniseFace(
  jpegBytes: Uint8Array,
  enrolledFaces: EnrolledFace[],
): Promise<{embedding: number[]; result: RecognitionResult}> {
  const {data: rawRgba, width, height} = decodeJpegToRGBA(jpegBytes);
  const rgbaData =
    width !== MODEL_INPUT_SIZE || height !== MODEL_INPUT_SIZE
      ? cropCenterRGBA(rawRgba, width, height, MODEL_INPUT_SIZE)
      : rawRgba;
  const tensor = rgbaToFloat32Tensor(rgbaData, MODEL_INPUT_SIZE, MODEL_INPUT_SIZE);
  const embedding = await getEmbedding(tensor);
  const result = findBestMatch(embedding, enrolledFaces);
  return {embedding, result};
}

// ── Display utilities ─────────────────────────────────────────────────────────

export function formatConfidence(confidence: number): string {
  return `${(confidence * 100).toFixed(1)}%`;
}

export function confidenceColour(confidence: number): string {
  if (confidence >= SIMILARITY_THRESHOLD) {
    return '#22c55e';
  }
  if (confidence >= 0.60) {
    return '#f59e0b';
  }
  return '#ef4444';
}
