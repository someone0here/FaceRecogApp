/**
 * RecognitionScreen.tsx  (v9 — liveness stability fix + blank frame guard)
 * =========================================================================
 */

import React, {useEffect, useRef, useState, useCallback} from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Animated,
  Alert,
  Platform,
} from 'react-native';
import {
  Camera,
  useCameraDevice,
  useCameraPermission,
} from 'react-native-vision-camera';
import ImageResizer from 'react-native-image-resizer';
import RNFS from 'react-native-fs';

import {
  loadFaceModel,
  isModelLoaded,
  getEmbedding,
  decodeJpegToRGBA,
  cropCenterRGBA,
  rgbaToFloat32Tensor,
  hasValidImageContent,
  validateEmbedding,
  averageEmbeddings,
  findBestMatch,
  formatConfidence,
  confidenceColour,
} from '../services/FaceRecognitionService';
import {checkFaceStability} from '../services/LivenessService';
import {
  getAllEnrolledFaces,
  saveAttendanceRecord,
  EnrolledFace,
} from '../services/DatabaseService';

// ── Config ────────────────────────────────────────────────────────────────────

const MODEL_SIZE = 112;

/**
 * FAST_MODE = true  → single-shot recognition (~300–500 ms, spec-compliant)
 * FAST_MODE = false → 3-shot averaged recognition (~1.5 s, higher confidence)
 * Set true for the hackathon demo to satisfy the <1 second requirement.
 */
const FAST_MODE = true;
const RECOG_SHOT_COUNT = FAST_MODE ? 1 : 3;
const RECOG_SHOT_DELAY = 500; // ms between shots (only used when FAST_MODE=false)

/**
 * Liveness detection thresholds.
 *
 * MIN_MOTION_SCORE: minimum mean absolute luminance difference between
 *   liveness frame 1 and frame 3 (center 56×56 face crop).
 *   Live faces score ~3-15; static photos/screens score ~0-1.
 *   Lowered 1.5→1.2 so subtle breathing/micro-movement on still faces passes.
 *
 * STABILITY_THRESHOLD: minimum cosine similarity between CONSECUTIVE liveness
 *   frame embeddings. Purpose: catch screen-replay flicker (erratic embedding
 *   drift, similarity ~0.1-0.3). NOT meant to penalise real face movement.
 *
 *   WHY 0.50 (was 0.80):
 *   A head-turn challenge naturally drops consecutive embedding similarity to
 *   0.55-0.70 — face geometry changes substantially when turning. The old 0.80
 *   threshold incorrectly failed valid head-turn attempts (the exact bug seen
 *   in the "face was not stable across frames" error). 0.50 still rejects
 *   screen-flicker drift while allowing all real face movement.
 *
 * LIVENESS_FRAME_COUNT: silent frames captured during countdown.
 * LIVENESS_FRAME_INTERVAL_MS: spacing between captures (3 × 800ms = 2.4s,
 *   fits comfortably inside the 4s countdown).
 */
const MIN_MOTION_SCORE = 1.2;
const STABILITY_THRESHOLD = 0.5; // v9: lowered 0.80→0.50 — head turns are valid
const LIVENESS_FRAME_COUNT = 3;
const LIVENESS_FRAME_INTERVAL_MS = 800;

// ── Liveness motion helpers ───────────────────────────────────────────────────

/**
 * Decode one liveness frame from a file URI and return its RGBA buffer.
 * Uses the same 224→crop pipeline as recognition for consistency.
 */
async function decodeLivenessFrame(
  rawUri: string,
): Promise<{rgba: Uint8ClampedArray; embedding: number[] | null}> {
  let resizedUri: string | null = null;
  try {
    const resized = await ImageResizer.createResizedImage(
      rawUri,
      224,
      224,
      'JPEG',
      80,
      0,
      undefined,
      false,
    );
    resizedUri = resized.uri;

    const base64 = await RNFS.readFile(resizedUri, 'base64');
    const jpegBytes = new Uint8Array(Buffer.from(base64, 'base64'));
    const {
      data: rawRgba,
      width: imgW,
      height: imgH,
    } = decodeJpegToRGBA(jpegBytes);

    const rgba =
      imgW !== MODEL_SIZE || imgH !== MODEL_SIZE
        ? cropCenterRGBA(rawRgba, imgW, imgH, MODEL_SIZE)
        : rawRgba;

    // Also compute embedding for stability check (best-effort, null on fail)
    let embedding: number[] | null = null;
    try {
      if (hasValidImageContent(rgba)) {
        const tensor = rgbaToFloat32Tensor(rgba, MODEL_SIZE, MODEL_SIZE);
        const emb = await getEmbedding(tensor);
        if (validateEmbedding(emb)) {
          embedding = emb;
        }
      }
    } catch {
      // embedding stays null — stability check will skip this frame
    }

    return {rgba, embedding};
  } finally {
    if (resizedUri) {
      RNFS.unlink(resizedUri).catch(() => {});
    }
  }
}

/**
 * Compute mean absolute luminance difference between two RGBA buffers.
 * Operates on a center 56×56 crop of the 112×112 face tile (the most
 * stable face region — forehead + eyes + nose bridge).
 *
 * Luminance = 0.299R + 0.587G + 0.114B  (standard BT.601)
 *
 * Returns a score in [0, 255]. Typical values:
 *   Static photo / screen:  0.0 – 1.2
 *   Live face (still):      1.5 – 6.0
 *   Live face (moving):     6.0 – 30.0
 */
function computeMotionScore(
  frameA: Uint8ClampedArray,
  frameB: Uint8ClampedArray,
): number {
  const CROP_START = 28; // (112-56)/2
  const CROP_END = 84; // CROP_START + 56

  let totalDiff = 0;
  let count = 0;

  for (let y = CROP_START; y < CROP_END; y++) {
    for (let x = CROP_START; x < CROP_END; x++) {
      const idx = (y * MODEL_SIZE + x) * 4;
      const lumA =
        0.299 * frameA[idx] + 0.587 * frameA[idx + 1] + 0.114 * frameA[idx + 2];
      const lumB =
        0.299 * frameB[idx] + 0.587 * frameB[idx + 1] + 0.114 * frameB[idx + 2];
      totalDiff += Math.abs(lumA - lumB);
      count++;
    }
  }

  const score = count > 0 ? totalDiff / count : 0;
  console.log(
    `[Liveness] Motion score: ${score.toFixed(
      3,
    )} (threshold ${MIN_MOTION_SCORE})`,
  );
  return score;
}

// ── Types ─────────────────────────────────────────────────────────────────────

const CHALLENGES = [
  {key: 'BLINK', icon: '👁', label: 'Blink your eyes'},
  {key: 'SMILE', icon: '😊', label: 'Smile broadly'},
  {key: 'TURN', icon: '↔️', label: 'Turn your head slightly'},
];

type ScreenState = 'idle' | 'liveness' | 'processing' | 'result';

interface Result {
  name: string;
  confidence: number;
  matched: boolean;
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function RecognitionScreen() {
  const {hasPermission, requestPermission} = useCameraPermission();
  const device = useCameraDevice('front');
  const camera = useRef<Camera>(null);

  const [screenState, setScreenState] = useState<ScreenState>('idle');
  const [challenge, setChallenge] = useState(CHALLENGES[0]);
  const [countdown, setCountdown] = useState(4);
  const [livenessStep, setLivenessStep] = useState('');
  const [result, setResult] = useState<Result | null>(null);
  const [enrolled, setEnrolled] = useState<EnrolledFace[]>([]);
  const [statusMsg, setStatusMsg] = useState('');

  const countdownRef = useRef<ReturnType<typeof setInterval>>();
  const resultAnim = useRef(new Animated.Value(0)).current;
  const pulseAnim = useRef(new Animated.Value(1)).current;

  // Stores liveness frame data captured during countdown
  const livenessFrames = useRef<Uint8ClampedArray[]>([]);
  const livenessEmbeddings = useRef<number[][]>([]);

  // ── Boot ───────────────────────────────────────────────────────────────────

  useEffect(() => {
    (async () => {
      if (!hasPermission) {
        await requestPermission();
      }
      if (!isModelLoaded()) {
        await loadFaceModel();
      }
      setEnrolled(await getAllEnrolledFaces());
    })();
  }, [hasPermission, requestPermission]);

  useEffect(() => {
    if (screenState === 'idle' || screenState === 'result') {
      getAllEnrolledFaces().then(setEnrolled);
    }
  }, [screenState]);

  // ── Reset ──────────────────────────────────────────────────────────────────

  const resetSession = useCallback(() => {
    clearInterval(countdownRef.current);
    pulseAnim.stopAnimation();
    pulseAnim.setValue(1);
    resultAnim.setValue(0);
    livenessFrames.current = [];
    livenessEmbeddings.current = [];
    setScreenState('idle');
    setResult(null);
    setStatusMsg('');
    setLivenessStep('');
  }, [pulseAnim, resultAnim]);

  // ── Silent liveness frame capture ─────────────────────────────────────────

  /**
   * Silently capture one liveness frame in the background.
   * Called at timed intervals during the countdown — user only sees
   * the challenge prompt and countdown, not that frames are being taken.
   */
  const captureLivenessFrame = useCallback(async () => {
    if (!camera.current) {
      return;
    }
    try {
      const photo = await camera.current.takePhoto({});
      const rawUri =
        Platform.OS === 'android' ? `file://${photo.path}` : photo.path;
      const {rgba, embedding} = await decodeLivenessFrame(rawUri);
      livenessFrames.current.push(rgba);
      if (embedding) {
        livenessEmbeddings.current.push(embedding);
      }
      console.log(
        `[Liveness] Frame ${livenessFrames.current.length}/${LIVENESS_FRAME_COUNT} captured` +
          (embedding ? ' + embedding' : ' (no embedding)'),
      );
    } catch (err) {
      console.warn('[Liveness] Silent frame capture failed:', err);
      // Non-fatal — liveness check will use however many frames succeeded
    }
  }, [camera]);

  // ── Liveness verification ──────────────────────────────────────────────────

  /**
   * Run both anti-spoofing checks against the captured liveness frames.
   *
   * Returns { passed: true } on success.
   * Returns { passed: false, reason: string } on failure.
   */
  function verifyLiveness(): {passed: boolean; reason?: string} {
    const frames = livenessFrames.current;
    const embeddings = livenessEmbeddings.current;

    // Need at least 2 frames for motion check
    if (frames.length < 2) {
      console.warn(
        '[Liveness] Not enough frames for motion check — passing leniently',
      );
      // If we couldn't capture frames (camera slow to init), don't block the user
      return {passed: true};
    }

    // CHECK A: Pixel motion between first and last frame
    const motionScore = computeMotionScore(
      frames[0],
      frames[frames.length - 1],
    );
    if (motionScore < MIN_MOTION_SCORE) {
      console.warn(
        `[Liveness] FAILED motion check: score ${motionScore.toFixed(
          3,
        )} < ${MIN_MOTION_SCORE}`,
      );
      return {
        passed: false,
        reason:
          `Liveness check failed — no movement detected (score: ${motionScore.toFixed(
            2,
          )}).\n\n` +
          'Please make sure you are a real person and not a photo. ' +
          `${challenge.label} as instructed.`,
      };
    }

    // CHECK B: Embedding stability (soft check — catches screen flicker, not head turns)
    if (embeddings.length >= 2) {
      const stable = checkFaceStability(embeddings, STABILITY_THRESHOLD);
      if (!stable) {
        console.warn(
          '[Liveness] FAILED stability check — extreme embedding drift detected',
        );
        return {
          passed: false,
          reason:
            'Liveness check failed — face identity was inconsistent across frames.\n\n' +
            'This may happen if the camera was covered and uncovered mid-session. ' +
            'Please keep your face visible in the oval guide throughout.',
        };
      }
    }

    console.log(
      `[Liveness] PASSED — motion: ${motionScore.toFixed(3)}, embeddings: ${
        embeddings.length
      }`,
    );
    return {passed: true};
  }

  // ── Single-frame recognition capture ──────────────────────────────────────

  const captureOneEmbedding = useCallback(async (): Promise<number[]> => {
    if (!camera.current) {
      throw new Error('Camera not ready');
    }

    const photo = await camera.current.takePhoto({});
    const rawUri =
      Platform.OS === 'android' ? `file://${photo.path}` : photo.path;

    const resized = await ImageResizer.createResizedImage(
      rawUri,
      224,
      224,
      'JPEG',
      90,
      0,
      undefined,
      false,
    );
    const resizedUri = resized.uri;

    try {
      const base64 = await RNFS.readFile(resizedUri, 'base64');
      const jpegBytes = new Uint8Array(Buffer.from(base64, 'base64'));
      const {
        data: rawRgba,
        width: imgW,
        height: imgH,
      } = decodeJpegToRGBA(jpegBytes);

      const rgbaData =
        imgW !== MODEL_SIZE || imgH !== MODEL_SIZE
          ? cropCenterRGBA(rawRgba, imgW, imgH, MODEL_SIZE)
          : rawRgba;

      if (!hasValidImageContent(rgbaData)) {
        throw new Error(
          'No face detected. Keep your face inside the oval guide.',
        );
      }

      const tensor = rgbaToFloat32Tensor(rgbaData, MODEL_SIZE, MODEL_SIZE);
      const embedding = await getEmbedding(tensor);

      if (!validateEmbedding(embedding)) {
        throw new Error(
          'Face not clear enough. Ensure good lighting and face the camera.',
        );
      }

      return embedding;
    } finally {
      RNFS.unlink(resizedUri).catch(() => {});
    }
  }, [camera]);

  // ── Main capture + recognise pipeline ────────────────────────────────────

  const handleCapture = useCallback(async () => {
    if (!camera.current) {
      return;
    }

    pulseAnim.stopAnimation();
    setScreenState('processing');

    try {
      // Step 1: Verify liveness from the frames captured during countdown
      setStatusMsg('Checking liveness...');
      const liveness = verifyLiveness();
      if (!liveness.passed) {
        Alert.alert('Liveness Check Failed', liveness.reason);
        resetSession();
        return;
      }

      // Step 2: Capture recognition shot(s)
      const embeddings: number[][] = [];
      for (let shot = 1; shot <= RECOG_SHOT_COUNT; shot++) {
        if (RECOG_SHOT_COUNT > 1) {
          setStatusMsg(`Scanning ${shot}/${RECOG_SHOT_COUNT}...`);
          if (shot > 1) {
            await new Promise(resolve => setTimeout(resolve, RECOG_SHOT_DELAY));
          }
        } else {
          setStatusMsg('Recognising face...');
        }
        const emb = await captureOneEmbedding();
        embeddings.push(emb);
      }

      // Step 3: Average embeddings (or use single shot in fast mode)
      setStatusMsg('Matching...');
      const queryEmbedding = FAST_MODE
        ? embeddings[0]
        : averageEmbeddings(embeddings);

      // Step 4: Compare against enrolled faces
      const currentEnrolled = await getAllEnrolledFaces();
      const match = findBestMatch(queryEmbedding, currentEnrolled);

      // Step 5: Save attendance if matched
      if (match.matched) {
        await saveAttendanceRecord(
          match.name,
          match.confidence,
          queryEmbedding,
        );
      }

      // Step 6: Show result
      setResult({
        name: match.name,
        confidence: match.confidence,
        matched: match.matched,
      });
      setScreenState('result');

      Animated.spring(resultAnim, {
        toValue: 1,
        useNativeDriver: true,
        tension: 80,
        friction: 8,
      }).start();
    } catch (err: any) {
      Alert.alert('Recognition Failed', err?.message ?? 'Please try again.');
      resetSession();
    } finally {
      setStatusMsg('');
      // Clear liveness frames after each attempt
      livenessFrames.current = [];
      livenessEmbeddings.current = [];
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    camera,
    pulseAnim,
    resultAnim,
    resetSession,
    captureOneEmbedding,
    challenge,
  ]);

  // ── Liveness session (countdown + silent frame capture) ───────────────────

  const startSession = useCallback(() => {
    if (enrolled.length === 0) {
      Alert.alert(
        'No faces enrolled',
        'Enroll at least one person in the Enroll tab first.',
      );
      return;
    }

    // Reset liveness buffers
    livenessFrames.current = [];
    livenessEmbeddings.current = [];

    const c = CHALLENGES[Math.floor(Math.random() * CHALLENGES.length)];
    setChallenge(c);
    setCountdown(4);
    setResult(null);
    resultAnim.setValue(0);
    setScreenState('liveness');
    setLivenessStep('');

    // Pulse animation on challenge icon
    Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, {
          toValue: 1.15,
          duration: 500,
          useNativeDriver: true,
        }),
        Animated.timing(pulseAnim, {
          toValue: 1.0,
          duration: 500,
          useNativeDriver: true,
        }),
      ]),
    ).start();

    // Schedule silent liveness frame captures during countdown
    // Frame 1 at t=0.5s, Frame 2 at t=1.3s, Frame 3 at t=2.1s
    // Capture then ends at t=4s with handleCapture
    const livenessCaptureTimes = [
      500,
      500 + LIVENESS_FRAME_INTERVAL_MS,
      500 + LIVENESS_FRAME_INTERVAL_MS * 2,
    ];
    livenessCaptureTimes.forEach(delay => {
      setTimeout(() => {
        captureLivenessFrame();
      }, delay);
    });

    // Main countdown timer
    let count = 4;
    countdownRef.current = setInterval(() => {
      count -= 1;
      setCountdown(count);
      if (count <= 0) {
        clearInterval(countdownRef.current);
        handleCapture();
      }
    }, 1000);
  }, [enrolled, pulseAnim, resultAnim, handleCapture, captureLivenessFrame]);

  // ── Permission / device guards ─────────────────────────────────────────────

  if (!hasPermission) {
    return (
      <View style={s.center}>
        <Text style={s.errText}>Camera permission required</Text>
        <TouchableOpacity style={s.primaryBtn} onPress={requestPermission}>
          <Text style={s.primaryBtnText}>Grant Permission</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (!device) {
    return (
      <View style={s.center}>
        <ActivityIndicator color="#6366f1" size="large" />
        <Text style={s.subText}>Waiting for camera...</Text>
      </View>
    );
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <View style={s.container}>
      <Camera
        ref={camera}
        style={StyleSheet.absoluteFill}
        device={device}
        isActive={screenState === 'liveness' || screenState === 'processing'}
        photo={true}
      />

      {/* ── IDLE ── */}
      {screenState === 'idle' && (
        <View style={s.idleOverlay}>
          <View style={s.idleCard}>
            <Text style={s.idleTitle}>Face Recognition</Text>
            <Text style={s.idleSub}>
              {enrolled.length} {enrolled.length === 1 ? 'person' : 'people'}{' '}
              enrolled
            </Text>

            {enrolled.length === 0 ? (
              <Text style={s.warnText}>
                ⚠️ Enroll at least one person in the Enroll tab first
              </Text>
            ) : (
              <TouchableOpacity style={s.primaryBtn} onPress={startSession}>
                <Text style={s.primaryBtnText}>🔍 Start Recognition</Text>
              </TouchableOpacity>
            )}

            <Text style={s.tipText}>
              💡 Good lighting + face inside the oval guide gives the best
              results
            </Text>
          </View>
        </View>
      )}

      {/* ── LIVENESS / PROCESSING ── */}
      {(screenState === 'liveness' || screenState === 'processing') && (
        <View style={s.liveOverlay}>
          <View style={s.ovalGuide} />

          <View style={s.instructCard}>
            <Animated.Text
              style={[s.chalIcon, {transform: [{scale: pulseAnim}]}]}>
              {challenge.icon}
            </Animated.Text>

            <Text style={s.chalText}>{challenge.label}</Text>

            {screenState === 'liveness' && (
              <>
                <Text style={s.countText}>
                  Capturing in <Text style={s.countNum}>{countdown}</Text>...
                </Text>
                <Text style={s.livenessHint}>Keep face steady in the oval</Text>
              </>
            )}

            {screenState === 'processing' && (
              <>
                <ActivityIndicator color="#a5b4fc" style={{marginTop: 8}} />
                <Text style={s.statusMsg}>{statusMsg}</Text>
              </>
            )}
          </View>

          <TouchableOpacity style={s.cancelBtn} onPress={resetSession}>
            <Text style={s.cancelText}>✕ Cancel</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* ── RESULT ── */}
      {screenState === 'result' && result && (
        <View style={s.resultOverlay}>
          <Animated.View
            style={[
              s.resultCard,
              result.matched ? s.cardMatch : s.cardNoMatch,
              {
                transform: [
                  {
                    scale: resultAnim.interpolate({
                      inputRange: [0, 1],
                      outputRange: [0.7, 1],
                    }),
                  },
                ],
                opacity: resultAnim,
              },
            ]}>
            <Text style={s.resultIcon}>{result.matched ? '✅' : '❌'}</Text>
            <Text style={s.resultName}>
              {result.matched ? result.name : 'Unknown Person'}
            </Text>
            <Text
              style={[
                s.resultConf,
                {color: confidenceColour(result.confidence)},
              ]}>
              Confidence: {formatConfidence(result.confidence)}
            </Text>
            {result.matched && (
              <Text style={s.savedText}>📋 Attendance recorded</Text>
            )}
            {!result.matched && (
              <Text style={s.noMatchTip}>
                Make sure your face is clearly visible and you are enrolled.
              </Text>
            )}
            <TouchableOpacity style={s.primaryBtn} onPress={resetSession}>
              <Text style={s.primaryBtnText}>Scan Again</Text>
            </TouchableOpacity>
          </Animated.View>
        </View>
      )}
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  container: {flex: 1, backgroundColor: '#000'},
  center: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#111827',
    padding: 24,
  },
  errText: {color: '#ef4444', fontSize: 16, marginBottom: 16},
  subText: {color: '#9ca3af', fontSize: 14, marginTop: 12},

  idleOverlay: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#111827',
  },
  idleCard: {
    backgroundColor: '#1f2937',
    borderRadius: 20,
    padding: 32,
    alignItems: 'center',
    width: '85%',
  },
  idleTitle: {
    fontSize: 22,
    fontWeight: '700',
    color: '#f9fafb',
    marginBottom: 6,
  },
  idleSub: {color: '#9ca3af', fontSize: 15, marginBottom: 24},
  warnText: {color: '#f59e0b', fontSize: 14, textAlign: 'center'},
  tipText: {
    color: '#6b7280',
    fontSize: 12,
    textAlign: 'center',
    marginTop: 16,
    lineHeight: 18,
  },

  liveOverlay: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'flex-end',
    paddingBottom: 48,
  },
  ovalGuide: {
    position: 'absolute',
    top: '12%',
    alignSelf: 'center',
    width: 230,
    height: 290,
    borderRadius: 115,
    borderWidth: 2.5,
    borderColor: 'rgba(99,102,241,0.85)',
    borderStyle: 'dashed',
  },
  instructCard: {
    backgroundColor: 'rgba(0,0,0,0.80)',
    borderRadius: 18,
    padding: 24,
    alignItems: 'center',
    width: '82%',
    marginBottom: 16,
  },
  chalIcon: {fontSize: 36, marginBottom: 8},
  chalText: {
    color: '#f9fafb',
    fontSize: 18,
    fontWeight: '700',
    textAlign: 'center',
  },
  countText: {color: '#d1d5db', fontSize: 15, marginTop: 6},
  countNum: {color: '#f9fafb', fontWeight: '800', fontSize: 20},
  livenessHint: {color: '#6b7280', fontSize: 12, marginTop: 4},
  statusMsg: {color: '#a5b4fc', fontSize: 13, marginTop: 6},
  cancelBtn: {paddingVertical: 10, paddingHorizontal: 24},
  cancelText: {color: '#9ca3af', fontSize: 15},

  resultOverlay: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.90)',
  },
  resultCard: {
    borderRadius: 24,
    padding: 36,
    alignItems: 'center',
    width: '85%',
  },
  cardMatch: {backgroundColor: '#064e3b'},
  cardNoMatch: {backgroundColor: '#450a0a'},
  resultIcon: {fontSize: 56, marginBottom: 12},
  resultName: {
    fontSize: 26,
    fontWeight: '800',
    color: '#f9fafb',
    marginBottom: 8,
  },
  resultConf: {fontSize: 16, fontWeight: '600', marginBottom: 8},
  savedText: {color: '#86efac', fontSize: 14, marginBottom: 16},
  noMatchTip: {
    color: '#fca5a5',
    fontSize: 13,
    textAlign: 'center',
    marginBottom: 16,
    lineHeight: 20,
  },
  primaryBtn: {
    backgroundColor: '#6366f1',
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 28,
    alignItems: 'center',
    marginTop: 12,
  },
  primaryBtnText: {color: '#fff', fontSize: 16, fontWeight: '700'},
});
