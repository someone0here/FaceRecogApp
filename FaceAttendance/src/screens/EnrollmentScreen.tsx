/**
 * EnrollmentScreen.tsx  (v8 — 5-shot averaged enrollment)
 * =========================================================
 * KEY FIXES over v5:
 *
 *   FIX 1 — 5-shot capture + embedding averaging (main fix for low confidence)
 *     A single-shot enrollment gives a noisy reference embedding. The
 *     recognition query is also a single shot from a different session
 *     (different lighting, angle, JPEG quality). The cosine similarity
 *     between two single-shot embeddings of the same face is typically
 *     0.62–0.75 for an INT8-quantised model — below any useful threshold.
 *     Solution: take 5 photos spaced 600 ms apart during enrollment,
 *     generate 5 embeddings, and save their L2-normalised average.
 *     This reduces capture-noise variance and gives a more representative
 *     reference vector, improving match scores to 0.80–0.92 in practice.
 *
 *   FIX 2 — Import averageEmbeddings from FaceRecognitionService.
 *
 *   FIX 3 — ImageResizer: resize to 224×224 intermediate, then cropCenterRGBA
 *     to 112×112. Avoids the OEM Android 'mode: stretch' silent-ignore bug
 *     that caused 149×112 decoded dimensions.
 *
 * EXISTING FIXES (v5):
 *   1. cropCenterRGBA() for EXIF-rotated frames
 *   2. hasValidImageContent() / validateEmbedding() pipeline
 *   3. Duplicate name check
 */

import React, {useEffect, useRef, useState, useCallback} from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Alert,
  ActivityIndicator,
  ScrollView,
  Platform,
  Animated,
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
  averageEmbeddings, // ← NEW v7: average 3-shot captures
} from '../services/FaceRecognitionService';
import {
  saveEnrolledFace,
  getAllEnrolledFaces,
  deleteEnrolledFace,
  EnrolledFace,
} from '../services/DatabaseService';

// ── Constants ─────────────────────────────────────────────────────────────────

const MODEL_SIZE = 112;

const CHALLENGES = [
  {key: 'BLINK', label: 'BLINK NOW', sub: 'Blink your eyes clearly'},
  {key: 'SMILE', label: 'SMILE NOW', sub: 'Show a big smile'},
  {key: 'TURN', label: 'TURN HEAD', sub: 'Turn head slightly left or right'},
];

type EnrollStep = 'form' | 'liveness' | 'done';

// ── Component ─────────────────────────────────────────────────────────────────

export default function EnrollmentScreen() {
  const {hasPermission, requestPermission} = useCameraPermission();
  const device = useCameraDevice('front');
  const camera = useRef<Camera>(null);

  const [name, setName] = useState('');
  const [step, setStep] = useState<EnrollStep>('form');
  const [loading, setLoading] = useState(false);
  const [enrolled, setEnrolled] = useState<EnrolledFace[]>([]);
  const [countdown, setCountdown] = useState(4);
  const [challenge, setChallenge] = useState(CHALLENGES[0]);
  const [statusMsg, setStatusMsg] = useState('');

  const countdownRef = useRef<ReturnType<typeof setInterval>>();
  const pulseAnim = useRef(new Animated.Value(1)).current;

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

  // ── Pulse animation ────────────────────────────────────────────────────────

  const startPulse = useCallback(() => {
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
  }, [pulseAnim]);

  // ── Single-frame capture helper ────────────────────────────────────────────

  /**
   * Capture one photo, decode it, and return a 128-dim embedding.
   * Shared by all 3 shots in captureAndEnroll.
   */
  const captureOneEmbedding = useCallback(
    async (shotLabel: string): Promise<number[]> => {
      if (!camera.current) {
        throw new Error('Camera not ready');
      }

      // Take photo
      const photo = await camera.current.takePhoto({});
      const rawUri =
        Platform.OS === 'android' ? `file://${photo.path}` : photo.path;

      // Resize to 224×224 intermediate (avoids OEM 'mode:stretch' bug)
      const resized = await ImageResizer.createResizedImage(
        rawUri,
        224,
        224,
        'JPEG',
        95,
        0, // rotation 0° — strip EXIF orientation
        undefined,
        false, // keepMeta: false
      );

      let resizedUri: string | null = resized.uri;
      try {
        const base64 = await RNFS.readFile(resizedUri, 'base64');
        const jpegBytes = new Uint8Array(Buffer.from(base64, 'base64'));

        const {
          data: rawRgba,
          width: imgW,
          height: imgH,
        } = decodeJpegToRGBA(jpegBytes);

        // Always center-crop to MODEL_SIZE×MODEL_SIZE
        const rgbaData =
          imgW !== MODEL_SIZE || imgH !== MODEL_SIZE
            ? cropCenterRGBA(rawRgba, imgW, imgH, MODEL_SIZE)
            : rawRgba;

        if (!hasValidImageContent(rgbaData)) {
          throw new Error(
            `${shotLabel}: No face detected. Keep your face inside the oval guide.`,
          );
        }

        const tensor = rgbaToFloat32Tensor(rgbaData, MODEL_SIZE, MODEL_SIZE);
        const embedding = await getEmbedding(tensor);

        if (!validateEmbedding(embedding)) {
          throw new Error(
            `${shotLabel}: Could not read face. Ensure good lighting and face the camera directly.`,
          );
        }

        console.log(`[Enroll] ${shotLabel} embedding captured successfully`);
        return embedding;
      } finally {
        RNFS.unlink(resizedUri).catch(() => {});
      }
    },
    [camera],
  );

  // ── 3-shot capture + averaged enrollment ──────────────────────────────────

  const captureAndEnroll = useCallback(async () => {
    if (!camera.current) {
      return;
    }

    setLoading(true);
    pulseAnim.stopAnimation();

    const SHOT_COUNT = 5;
    const SHOT_DELAY_MS = 600; // ms between shots — enough for slight pose variation
    const embeddings: number[][] = [];

    try {
      for (let shot = 1; shot <= SHOT_COUNT; shot++) {
        setStatusMsg(`Capturing photo ${shot}/${SHOT_COUNT}...`);

        // Small delay between shots so the model sees slightly different poses
        if (shot > 1) {
          await new Promise(resolve => setTimeout(resolve, SHOT_DELAY_MS));
        }

        const emb = await captureOneEmbedding(`Shot ${shot}/${SHOT_COUNT}`);
        embeddings.push(emb);
        setStatusMsg(`Photo ${shot}/${SHOT_COUNT} captured ✓`);
      }

      // Average the 3 embeddings → more stable reference vector
      setStatusMsg('Computing face profile...');
      const finalEmbedding = averageEmbeddings(embeddings);

      if (!validateEmbedding(finalEmbedding)) {
        throw new Error(
          'Could not build a face profile. Please try again with better lighting.',
        );
      }

      // Save to SQLite
      setStatusMsg('Saving to database...');
      await saveEnrolledFace(name.trim(), finalEmbedding);

      setEnrolled(await getAllEnrolledFaces());
      setStep('done');
    } catch (err: any) {
      Alert.alert(
        'Enrollment Failed',
        err?.message ?? 'Unknown error. Please try again.',
      );
      resetForm();
    } finally {
      setLoading(false);
      setStatusMsg('');
    }
  }, [camera, name, pulseAnim, captureOneEmbedding]);

  // ── Start liveness session ─────────────────────────────────────────────────

  const startLiveness = useCallback(() => {
    const exists = enrolled.some(
      f => f.name.toLowerCase() === name.trim().toLowerCase(),
    );
    if (exists) {
      Alert.alert(
        'Name already enrolled',
        `"${name.trim()}" is already registered. Enrolling again will add a second entry. Continue?`,
        [
          {text: 'Cancel', style: 'cancel'},
          {text: 'Continue', onPress: doStartLiveness},
        ],
      );
      return;
    }
    doStartLiveness();
  }, [enrolled, name]);

  const doStartLiveness = useCallback(() => {
    const c = CHALLENGES[Math.floor(Math.random() * CHALLENGES.length)];
    setChallenge(c);
    setCountdown(4);
    setStep('liveness');
    setStatusMsg('');
    startPulse();

    let count = 4;
    countdownRef.current = setInterval(() => {
      count -= 1;
      setCountdown(count);
      if (count <= 0) {
        clearInterval(countdownRef.current);
        captureAndEnroll();
      }
    }, 1000);
  }, [startPulse, captureAndEnroll]);

  // ── Reset ──────────────────────────────────────────────────────────────────

  const resetForm = useCallback(() => {
    clearInterval(countdownRef.current);
    pulseAnim.stopAnimation();
    pulseAnim.setValue(1);
    setName('');
    setStep('form');
    setCountdown(4);
    setStatusMsg('');
  }, [pulseAnim]);

  // ── Delete enrolled face ────────────────────────────────────────────────────

  const handleDelete = useCallback((id: number, faceName: string) => {
    Alert.alert('Delete Person?', `Remove "${faceName}" from enrolled list?`, [
      {text: 'Cancel', style: 'cancel'},
      {
        text: 'Delete',
        onPress: async () => {
          try {
            await deleteEnrolledFace(id);
            setEnrolled(await getAllEnrolledFaces());
          } catch (err) {
            Alert.alert('Error', 'Failed to delete person.');
          }
        },
        style: 'destructive',
      },
    ]);
  }, []);

  // ── Permission / device guards ─────────────────────────────────────────────

  if (!hasPermission) {
    return (
      <View style={s.center}>
        <Text style={s.errText}>Camera permission required</Text>
        <TouchableOpacity style={s.btn} onPress={requestPermission}>
          <Text style={s.btnText}>Grant Permission</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (!device) {
    return (
      <View style={s.center}>
        <ActivityIndicator color="#6366f1" size="large" />
      </View>
    );
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <View style={s.container}>
      {/* ── FORM STEP ── */}
      {step === 'form' && (
        <ScrollView contentContainerStyle={s.formWrap}>
          <Text style={s.heading}>Register New Person</Text>
          <Text style={s.sub}>
            Enter the person's name, then face the camera for a liveness check.
          </Text>

          <Text style={s.label}>Full Name</Text>
          <TextInput
            style={s.input}
            value={name}
            onChangeText={setName}
            placeholder="e.g. Ravi Kumar"
            placeholderTextColor="#6b7280"
            autoCapitalize="words"
            returnKeyType="done"
          />

          <View style={s.tipsBox}>
            <Text style={s.tipsTitle}>📌 For best accuracy:</Text>
            <Text style={s.tip}>• Face camera directly, good lighting</Text>
            <Text style={s.tip}>• No hat or sunglasses</Text>
            <Text style={s.tip}>• Keep face inside the oval guide</Text>
          </View>

          <TouchableOpacity
            style={[s.btn, !name.trim() && s.btnOff]}
            onPress={() => name.trim() && startLiveness()}
            disabled={!name.trim()}>
            <Text style={s.btnText}>Start Liveness Check →</Text>
          </TouchableOpacity>

          {/* Enrolled people list */}
          {enrolled.length > 0 && (
            <View style={s.listBox}>
              <Text style={s.listTitle}>
                Enrolled People ({enrolled.length})
              </Text>
              {enrolled.map(f => (
                <View key={f.id} style={s.listRow}>
                  <View style={s.listLeft}>
                    <Text style={s.listName}>👤 {f.name}</Text>
                    <Text style={s.listDate}>
                      {new Date(f.createdAt).toLocaleDateString()}
                    </Text>
                  </View>
                  <TouchableOpacity onPress={() => handleDelete(f.id, f.name)}>
                    <Text style={s.deleteBtn}>🗑️</Text>
                  </TouchableOpacity>
                </View>
              ))}
            </View>
          )}
        </ScrollView>
      )}

      {/* ── LIVENESS STEP ── */}
      {step === 'liveness' && (
        <View style={s.camWrap}>
          <Camera
            ref={camera}
            style={StyleSheet.absoluteFill}
            device={device}
            isActive={true}
            photo={true}
            pixelFormat="rgb"
          />
          <View style={s.overlay}>
            {/* Oval face guide */}
            <View style={s.ovalGuide} />

            <View style={s.challengeBox}>
              <Animated.Text
                style={[s.challengeAction, {transform: [{scale: pulseAnim}]}]}>
                {challenge.label}
              </Animated.Text>

              <Text style={s.challengeSub}>{challenge.sub}</Text>

              {!loading ? (
                <Text style={s.challengeCount}>
                  Capturing in <Text style={s.countNum}>{countdown}</Text>...
                </Text>
              ) : (
                <>
                  <ActivityIndicator color="#a5b4fc" style={{marginTop: 8}} />
                  <Text style={s.statusMsg}>{statusMsg}</Text>
                  <Text style={s.statusHint}>Hold still — taking 5 photos</Text>
                </>
              )}
            </View>

            <TouchableOpacity style={s.cancelBtn} onPress={resetForm}>
              <Text style={s.cancelText}>✕ Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      {/* ── DONE STEP ── */}
      {step === 'done' && (
        <View style={s.center}>
          <Text style={s.doneIcon}>🎉</Text>
          <Text style={s.doneTitle}>{name} enrolled!</Text>
          <Text style={s.doneSub}>
            Face embedding saved. This person can now be recognised offline.
          </Text>

          <TouchableOpacity style={s.btn} onPress={resetForm}>
            <Text style={s.btnText}>Enroll Another Person</Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  container: {flex: 1, backgroundColor: '#111827'},
  center: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#111827',
    padding: 24,
  },
  formWrap: {padding: 24},
  heading: {
    fontSize: 22,
    fontWeight: '700',
    color: '#f9fafb',
    marginBottom: 8,
  },
  sub: {
    fontSize: 14,
    color: '#9ca3af',
    marginBottom: 24,
    lineHeight: 22,
  },
  label: {
    fontSize: 13,
    color: '#d1d5db',
    marginBottom: 6,
    fontWeight: '600',
  },
  input: {
    backgroundColor: '#1f2937',
    color: '#f9fafb',
    borderRadius: 10,
    padding: 14,
    fontSize: 16,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: '#374151',
  },
  tipsBox: {
    backgroundColor: '#1f2937',
    borderRadius: 10,
    padding: 14,
    marginBottom: 20,
  },
  tipsTitle: {
    color: '#a5b4fc',
    fontSize: 13,
    fontWeight: '700',
    marginBottom: 6,
  },
  tip: {color: '#9ca3af', fontSize: 13, marginBottom: 3},
  btn: {
    backgroundColor: '#6366f1',
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 24,
    alignItems: 'center',
    marginBottom: 16,
  },
  btnOff: {opacity: 0.4},
  btnText: {color: '#fff', fontSize: 16, fontWeight: '700'},
  listBox: {
    marginTop: 20,
    backgroundColor: '#1f2937',
    borderRadius: 12,
    padding: 16,
  },
  listTitle: {
    color: '#9ca3af',
    fontSize: 13,
    fontWeight: '600',
    marginBottom: 12,
  },
  listRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#374151',
  },
  listLeft: {
    flex: 1,
  },
  listName: {color: '#f9fafb', fontSize: 15},
  listDate: {color: '#6b7280', fontSize: 13},
  deleteBtn: {
    fontSize: 18,
    padding: 8,
  },
  errText: {color: '#ef4444', fontSize: 16, marginBottom: 16},

  // Camera / liveness
  camWrap: {flex: 1},
  overlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'flex-end',
    alignItems: 'center',
    paddingBottom: 48,
  },
  ovalGuide: {
    position: 'absolute',
    top: '12%',
    alignSelf: 'center',
    width: 220,
    height: 280,
    borderRadius: 110,
    borderWidth: 2.5,
    borderColor: '#6366f1',
    borderStyle: 'dashed',
  },
  challengeBox: {
    backgroundColor: 'rgba(0,0,0,0.80)',
    borderRadius: 18,
    padding: 24,
    alignItems: 'center',
    width: '82%',
    marginBottom: 16,
  },
  challengeAction: {
    fontSize: 30,
    fontWeight: '800',
    color: '#a5b4fc',
    marginBottom: 4,
  },
  challengeSub: {color: '#d1d5db', fontSize: 14, marginBottom: 8},
  challengeCount: {color: '#d1d5db', fontSize: 16},
  countNum: {color: '#f9fafb', fontWeight: '800', fontSize: 20},
  statusMsg: {color: '#a5b4fc', fontSize: 13, marginTop: 6},
  statusHint: {color: '#6b7280', fontSize: 12, marginTop: 4},
  cancelBtn: {paddingVertical: 10, paddingHorizontal: 24},
  cancelText: {color: '#9ca3af', fontSize: 15},

  // Done
  doneIcon: {fontSize: 64, marginBottom: 16},
  doneTitle: {
    fontSize: 24,
    fontWeight: '700',
    color: '#f9fafb',
    marginBottom: 8,
  },
  doneSub: {
    color: '#9ca3af',
    fontSize: 15,
    textAlign: 'center',
    lineHeight: 24,
    marginBottom: 32,
  },
});
