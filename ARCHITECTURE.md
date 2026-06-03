# 🏗️ System Architecture

> Technical deep dive into FaceRecogApp's offline-first architecture

---

## Table of Contents

- [High-Level Architecture](#high-level-architecture)
- [Component Architecture](#component-architecture)
- [Data Flow](#data-flow)
- [Offline-First Design](#offline-first-design)
- [AI/ML Pipeline](#aiml-pipeline)
- [Database Schema](#database-schema)
- [Security Architecture](#security-architecture)
- [API Reference](#api-reference)

---

## High-Level Architecture

```
┌─────────────────────────────────────────────────────┐
│              MOBILE APPLICATION                     │
│         (React Native + TypeScript)                 │
├─────────────────────────────────────────────────────┤
│  UI Layer          │ Business Logic    │ Data Layer │
│  Components        │ Managers          │ Database   │
└────────┬───────────┬───────────────────┬────────────┘
         │           │                   │
         ▼           ▼                   ▼
┌─────────────────────────────────────────────────────┐
│        ON-DEVICE AI PROCESSING PIPELINE             │
├─────────────────────────────────────────────────────┤
│  Camera Integration → Image Processing → TFLite ML  │
└────────┬───────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────┐
│           LOCAL PERSISTENCE LAYER                   │
├─────────────────────────────────────────────────────┤
│  SQLite Database (Enrollments, Embeddings, Logs)   │
└────────┬───────────────────────────────────────────┘
         │ (When Online)
         ▼
┌─────────────────────────────────────────────────────┐
│           CLOUD SYNCHRONIZATION (Optional)          │
├─────────────────────────────────────────────────────┤
│  AWS Lambda → DynamoDB → S3 → CloudFront           │
└─────────────────────────────────────────────────────┘
```

---

## Component Architecture

### 1. Frontend Layer (React Native)

**Directory**: `FaceAttendance/src/`

**Core Components**:

- **Screens**: User-facing UI views (Enrollment, Recognition, Attendance)
- **Navigation**: React Navigation for screen flow management
- **Hooks**: Custom React hooks for state management and side effects

**Example Structure**:

```
src/
├── screens/
│   ├── EnrollmentScreen.tsx
│   ├── RecognitionScreen.tsx
│   ├── AttendanceScreen.tsx
│   └── SettingsScreen.tsx
├── components/
│   ├── CameraView.tsx
│   ├── FacePreview.tsx
│   └── StatusIndicator.tsx
├── hooks/
│   ├── useCamera.ts
│   ├── useAttendance.ts
│   └── useFaceRecognition.ts
└── navigation/
    └── RootNavigator.tsx
```

### 2. Business Logic Layer

**Face Recognition Manager**:

- Handles enrollment process
- Manages face embedding generation
- Performs similarity matching
- Controls liveness detection

**Attendance Manager**:

- Creates attendance records
- Manages local history
- Handles synchronization queue
- Manages attendance metadata

**Storage Manager**:

- SQLite database operations
- Encryption/decryption if enabled
- Database migrations
- Backup management

### 3. AI/ML Integration Layer

**TensorFlow Lite Integration**:

- Model loading and initialization
- Inference execution
- Embedding generation
- Performance monitoring

**Image Processing**:

- Quality validation
- Preprocessing and normalization
- Face detection
- Image optimization

### 4. Data Persistence Layer

**SQLite Database**:

- User enrollment data
- Face embeddings (128D vectors)
- Attendance records
- Metadata and audit trails

---

## Data Flow

### Enrollment Flow

```
User Selection
    ↓
Camera Initialization
    ↓
Capture Multiple Frames (3-5 recommended)
    ↓
Image Quality Validation
    │ └─ Brightness Check
    │ └─ Content Validation
    │ └─ Face Detection Confidence
    ↓
TensorFlow Lite Inference (per frame)
    │ └─ Input: 112×112 RGB image
    │ └─ Output: 128D normalized embedding
    ↓
Embedding Averaging
    │ └─ Calculate mean of all embeddings
    │ └─ L2 Normalization
    ↓
Store in SQLite
    │ └─ User ID
    │ └─ Averaged embedding
    │ └─ Enrollment metadata
    ↓
Success Response
```

### Recognition Flow

```
Camera Initialization
    ↓
Capture Test Image
    ↓
Image Quality Validation
    ↓
Face Detection & Extraction
    ↓
TensorFlow Lite Inference
    │ └─ Generate 128D embedding
    ↓
Load Enrolled Embeddings from SQLite
    ↓
Calculate Cosine Similarity
    │ └─ Compare against all enrolled faces
    │ └─ Score: 0 to 1 (1 = perfect match)
    ↓
Rank Matches by Similarity Score
    ↓
Decision Logic
    │ ├─ Score > 0.85? → Recognized
    │ ├─ Score 0.70-0.85? → Uncertain (ask user)
    │ └─ Score < 0.70? → Not recognized
    ↓
Log Attendance (if recognized)
    ├─ User ID
    ├─ Timestamp
    ├─ Confidence Score
    └─ Device Info
    ↓
Return Result
```

### Liveness Detection Flow

```
Initiate Liveness Check
    ↓
Capture Multiple Frames (Challenge-based)
    ├─ Frame 1: Normal position
    ├─ Frame 2: Look left
    ├─ Frame 3: Look right
    └─ Frame 4: Blink/smile
    ↓
Generate Embeddings for Each Frame
    ↓
Calculate Embedding Variance
    ├─ Should vary naturally across frames
    └─ Static variance = potential spoof
    ↓
Face Consistency Analysis
    ├─ All frames same person?
    ├─ Face position changes realistically?
    └─ Lighting consistent?
    ↓
Aggregate Liveness Score
    │ └─ Multi-factor scoring
    ↓
Decision
    ├─ Score > 0.90? → Live
    └─ Score < 0.90? → Potential spoof
    ↓
Return Liveness Result
```

---

## Offline-First Design

### Core Principles

1. **Local First**: All operations work without connectivity
2. **Sync When Possible**: Data automatically syncs when online
3. **Conflict Resolution**: Intelligent handling of divergent updates
4. **Graceful Degradation**: Features degrade gracefully without network

### Implementation Details

**Local Storage**:

```typescript
// All data stored locally first
const enrollment = {
  userId: "user_001",
  embedding: [0.234, -0.567, ...], // 128D vector
  timestamp: 1685000000000,
  deviceId: "device_123",
  status: "enrolled"
};

database.save('enrollments', enrollment);
```

**Sync Queue**:

```typescript
// Track what needs syncing
const syncQueue = {
  enrollments: [{ id, status: "pending_sync" }],
  attendanceRecords: [{ id, status: "pending_sync" }],
  deletedRecords: [{ id, deletedAt }],
};

// When online, process queue
if (isOnline()) {
  await syncQueue.flush();
}
```

**Conflict Resolution**:

```
Local Data: Last Modified = 10:05 AM
Cloud Data: Last Modified = 10:10 AM

Resolution Strategy:
1. Keep cloud version (more recent)
2. Log conflict in audit trail
3. Notify user if action needed
4. Merge if possible
```

---

## AI/ML Pipeline

### Model Architecture

```
Input Image (112 × 112 × 3)
    ↓
MobileNetV2 Backbone
    ├─ Depthwise Separable Convolutions
    ├─ Inverted Residual Blocks
    └─ Bottleneck Architecture
    ↓
Face Embedding Layer
    ├─ 128-dimensional output
    └─ L2 Normalization
    ↓
Output Embedding (128D normalized vector)
```

### Inference Process

**Model Details**:

- **Format**: TensorFlow Lite (TFLite)
- **Quantization**: INT8 (8-bit integer)
- **Size**: ~3.3 MB
- **Inference Time**: <100ms per frame (varies by device)
- **Memory**: ~50-100 MB during inference

**Loading Model**:

```typescript
// Device-side model loading
const interpreter = await tflite.loadModel("face_embedding_model.tflite");

// Prepare input
const input = preprocessImage(cameraFrame); // 112×112×3

// Run inference
const output = await interpreter.run(input);

// Output shape: [1, 128] → extract [128] embedding
const embedding = output[0];
const normalizedEmbedding = normalize(embedding); // L2 norm
```

### Similarity Matching

**Cosine Similarity Formula**:

```
similarity = (A · B) / (||A|| * ||B||)

Where:
  A · B = dot product
  ||A||, ||B|| = L2 norms
  Result range: -1 to 1 (typically 0 to 1 for normalized vectors)
```

**Matching Algorithm**:

```typescript
// Calculate similarity to all enrolled faces
const scores = enrolledEmbeddings.map((enrolled) =>
  cosineSimilarity(testEmbedding, enrolled),
);

// Find best match
const bestMatchIndex = scores.indexOf(Math.max(...scores));
const bestScore = scores[bestMatchIndex];
const confidence = bestScore * 100; // Convert to percentage

// Recognition threshold
if (confidence > 85) {
  return {
    recognized: true,
    userId: enrolledUsers[bestMatchIndex],
    confidence,
  };
} else {
  return {
    recognized: false,
    topMatch: enrolledUsers[bestMatchIndex],
    confidence,
  };
}
```

---

## Database Schema

### SQLite Tables

**Users Table**:

```sql
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT,
  enrolledAt INTEGER,
  lastRecognizedAt INTEGER,
  status TEXT DEFAULT 'active', -- active, inactive, blocked
  metadata JSON
);
```

**Enrollments Table**:

```sql
CREATE TABLE enrollments (
  id TEXT PRIMARY KEY,
  userId TEXT NOT NULL,
  embedding BLOB NOT NULL, -- 128D vector as binary
  captureCount INTEGER,
  enrolledAt INTEGER,
  quality REAL, -- 0-100 quality score
  syncStatus TEXT DEFAULT 'pending', -- pending, synced, failed
  FOREIGN KEY (userId) REFERENCES users(id)
);
```

**Attendance Records Table**:

```sql
CREATE TABLE attendance (
  id TEXT PRIMARY KEY,
  userId TEXT NOT NULL,
  timestamp INTEGER,
  recognitionScore REAL, -- 0-100 confidence
  livenessScore REAL,
  location TEXT,
  status TEXT DEFAULT 'logged', -- logged, pending_sync, synced
  deviceId TEXT,
  metadata JSON,
  FOREIGN KEY (userId) REFERENCES users(id)
);
```

**Sync Queue Table**:

```sql
CREATE TABLE sync_queue (
  id TEXT PRIMARY KEY,
  entityType TEXT, -- 'enrollment', 'attendance', 'user'
  entityId TEXT,
  operation TEXT, -- 'create', 'update', 'delete'
  payload JSON,
  createdAt INTEGER,
  status TEXT DEFAULT 'pending' -- pending, synced, failed
);
```

**Indexes** (for performance):

```sql
CREATE INDEX idx_user_id ON enrollments(userId);
CREATE INDEX idx_attendance_user ON attendance(userId);
CREATE INDEX idx_attendance_timestamp ON attendance(timestamp);
CREATE INDEX idx_sync_status ON sync_queue(status);
```

---

## Security Architecture

### Data Security

**On-Device Processing**:

- All face embeddings generated locally
- Embeddings never transmitted unencrypted
- Camera feed processed entirely on-device
- No raw images stored (only embeddings)

**Database Encryption** (Optional):

```typescript
// SQLite encryption using SQLCipher
import SQLite from "react-native-sqlite-storage";

const db = SQLite.openDatabase({
  name: "facerecog.db",
  location: "default",
  key: "encryption_passphrase", // Encrypt database
});
```

**Enrollment Data Protection**:

- Embeddings stored as normalized vectors (not reversible)
- User metadata encrypted separately
- Sensitive fields use salted hashing

### Biometric Privacy

**No Template Leakage**:

- Embeddings are 128D mathematical representations
- Cannot reconstruct face image from embedding
- Industry-standard cancelable biometrics ready

**Audit Trail**:

- All access logged with timestamp
- Failed recognition attempts recorded
- User consent tracking maintained

### Cloud Sync Security

**Transmission**:

- HTTPS/TLS 1.3+ required
- Certificate pinning (optional)
- Payload encryption with AES-256

**Cloud Storage** (AWS):

- Encryption at rest (KMS)
- Encryption in transit (TLS)
- IAM role-based access
- CloudTrail logging

---

## API Reference

### Face Recognition Module

```typescript
interface FaceRecognitionManager {
  // Enrollment
  startEnrollment(userId: string): Promise<void>;
  captureFrame(): Promise<Uint8Array>;
  addEnrollmentFrame(frame: Uint8Array): Promise<void>;
  completeEnrollment(): Promise<{ success: boolean; enrollmentId: string }>;

  // Recognition
  startRecognition(): Promise<void>;
  captureRecognitionFrame(): Promise<Uint8Array>;
  recognize(): Promise<{
    recognized: boolean;
    userId?: string;
    confidence: number;
    topMatches: Array<{ userId: string; score: number }>;
  }>;

  // Liveness Detection
  startLivenessCheck(): Promise<void>;
  performLivenessDetection(): Promise<{
    isLive: boolean;
    score: number;
    details: { embedding_variance: number; face_consistency: number };
  }>;
}
```

### Attendance Manager

```typescript
interface AttendanceManager {
  // Logging
  logAttendance(userId: string, confidence: number): Promise<AttendanceRecord>;

  // History
  getAttendanceHistory(
    userId: string,
    startDate?: Date,
    endDate?: Date,
  ): Promise<AttendanceRecord[]>;
  getAllAttendance(
    startDate?: Date,
    endDate?: Date,
  ): Promise<AttendanceRecord[]>;

  // Sync
  getUnsyncedRecords(): Promise<AttendanceRecord[]>;
  markAsSynced(recordIds: string[]): Promise<void>;
}
```

### Storage Module

```typescript
interface StorageManager {
  // Database
  initialize(): Promise<void>;
  saveUser(user: User): Promise<void>;
  saveEnrollment(enrollment: Enrollment): Promise<void>;
  saveAttendance(record: AttendanceRecord): Promise<void>;

  // Queries
  getUserById(userId: string): Promise<User | null>;
  getAllUsers(): Promise<User[]>;
  getEnrollmentsByUser(userId: string): Promise<Enrollment[]>;
}
```

---

## Performance Optimization

### Inference Optimization

**Model Quantization**:

- INT8 quantization reduces model size by 75%
- Minimal accuracy loss (<1%)
- Faster inference on CPU

**Parallel Processing**:

- Process multiple frames in background
- Non-blocking UI updates
- Efficient resource utilization

**Caching**:

- Cache enrolled embeddings in memory
- Reduce repeated database queries
- Invalidate cache on updates

### Memory Management

**Resource Cleanup**:

```typescript
// Release TensorFlow resources
useEffect(() => {
  return () => {
    tf.dispose(); // Clean up tensors
  };
}, []);
```

**Image Optimization**:

- Resize camera frames to 112×112
- Use efficient image formats
- Release buffers after processing

---

## Deployment Architecture

### Mobile App Deployment

**Android**:

- APK: Signed release APK for distribution
- AAB: Android App Bundle for Google Play
- Models bundled in APK (~3.3 MB)
- Offline-first, no internet required

**iOS**:

- IPA: iOS app archive for App Store
- Models bundled in app bundle
- Supports iOS 13+
- Works offline

### Cloud Sync Deployment (Optional)

**AWS Architecture**:

```
API Gateway
    ↓
Lambda Functions
    ├─ POST /enrollments (handle new enrollments)
    ├─ POST /attendance (handle attendance sync)
    └─ GET /sync (pull cloud updates)
    ↓
DynamoDB Tables
    ├─ Users
    ├─ Enrollments
    └─ Attendance
    ↓
S3 Storage (backups)
    ↓
CloudFront (CDN)
```

---

## Future Architecture Enhancements

1. **Federated Learning**: Train models on-device without sharing data
2. **Multi-Face Recognition**: Detect and identify multiple people in frame
3. **Advanced Spoofing Detection**: Optical flow analysis, texture analysis
4. **Encrypted Backup**: Automatic encrypted backup to cloud
5. **Administrative Dashboard**: Web portal for attendance management

---

## Conclusion

FaceRecogApp's architecture prioritizes:

- ✅ **Offline-First**: Complete functionality without connectivity
- ✅ **Security**: On-device processing with no data leakage
- ✅ **Performance**: <100ms inference for real-time recognition
- ✅ **Scalability**: Efficient local database with cloud sync
- ✅ **Privacy**: Facial embeddings cannot be reversed

The system is production-ready and deployable on any modern smartphone.

---

For more details, see [INSTALLATION.md](INSTALLATION.md) or [PROJECT.md](PROJECT.md).
