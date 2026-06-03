/**
 * SyncService.ts
 * ==============
 * Syncs attendance records to AWS when internet is available.
 *
 * Flow:
 *   1. Fetch unsynced records from SQLite
 *   2. Upload each to DynamoDB (attendance table)
 *   3. Upload embeddings batch to S3 (for audit/ML retraining)
 *   4. Mark records as synced in SQLite
 *   5. Purge synced records from local storage
 *
 * Handles:
 *   - Partial sync failure (only marks successful uploads)
 *   - Retry with exponential backoff
 *   - Duplicate prevention (uses record id + timestamp as DynamoDB key)
 */

import {
  getUnsyncedRecords,
  markRecordsSynced,
  purgeSyncedRecords,
  AttendanceRecord,
} from './DatabaseService';

// ── AWS Configuration ─────────────────────────────────────────────────────────
// Replace these with your actual AWS credentials and resource names.
// In production, use AWS Cognito Identity Pool (never hardcode keys in app).

const AWS_CONFIG = {
  region: 'ap-south-1',                    // Mumbai — closest to India
  dynamoTableName: 'FaceAttendance',
  s3BucketName: 'face-attendance-sync',
  // For hackathon demo: use temporary IAM credentials
  // For production: use Cognito Identity Pool
  accessKeyId: 'YOUR_ACCESS_KEY_ID',
  secretAccessKey: 'YOUR_SECRET_ACCESS_KEY',
};

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SyncResult {
  success: boolean;
  uploaded: number;
  failed: number;
  purged: number;
  error?: string;
}

export interface SyncProgress {
  total: number;
  current: number;
  currentName: string;
}

// ── Retry helper ──────────────────────────────────────────────────────────────

async function withRetry<T>(
  fn: () => Promise<T>,
  maxAttempts = 3,
  delayMs = 1000,
): Promise<T> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err as Error;
      console.warn(`[Sync] Attempt ${attempt}/${maxAttempts} failed:`, err);
      if (attempt < maxAttempts) {
        // Exponential backoff: 1s, 2s, 4s
        await new Promise(r => setTimeout(r, delayMs * Math.pow(2, attempt - 1)));
      }
    }
  }

  throw lastError!;
}

// ── DynamoDB upload ───────────────────────────────────────────────────────────

/**
 * Upload a single attendance record to DynamoDB.
 *
 * DynamoDB item schema:
 *   PK (partition key): attendanceId  → unique per record
 *   SK (sort key):      timestamp
 *   name, confidence, embeddingSnapshot, deviceId, appVersion
 */
async function uploadToDynamoDB(record: AttendanceRecord): Promise<void> {
  // Dynamic import to avoid bundling AWS SDK at startup
  const AWS = require('aws-sdk');

  AWS.config.update({
    region: AWS_CONFIG.region,
    accessKeyId: AWS_CONFIG.accessKeyId,
    secretAccessKey: AWS_CONFIG.secretAccessKey,
  });

  const dynamo = new AWS.DynamoDB.DocumentClient();

  const item = {
    attendanceId: `${record.id}_${record.timestamp.replace(/\D/g, '')}`,
    timestamp:    record.timestamp,
    name:         record.name,
    confidence:   record.confidence,
    // Don't upload the full embedding to DynamoDB (too large) — just metadata
    embeddingSize: JSON.parse(record.embeddingSnapshot || '[]').length,
    syncedAt:      new Date().toISOString(),
  };

  await withRetry(() =>
    dynamo.put({
      TableName:           AWS_CONFIG.dynamoTableName,
      Item:                item,
      // Prevent overwriting if already uploaded (idempotent)
      ConditionExpression: 'attribute_not_exists(attendanceId)',
    }).promise()
  );
}

/**
 * Upload all embeddings in a batch to S3 as a JSON file.
 * One file per sync session, named by timestamp.
 */
async function uploadToS3(records: AttendanceRecord[]): Promise<void> {
  const AWS = require('aws-sdk');

  AWS.config.update({
    region:          AWS_CONFIG.region,
    accessKeyId:     AWS_CONFIG.accessKeyId,
    secretAccessKey: AWS_CONFIG.secretAccessKey,
  });

  const s3 = new AWS.S3();

  const payload = {
    syncTimestamp: new Date().toISOString(),
    recordCount:   records.length,
    records:       records.map(r => ({
      id:         r.id,
      name:       r.name,
      confidence: r.confidence,
      timestamp:  r.timestamp,
      embedding:  JSON.parse(r.embeddingSnapshot || '[]'),
    })),
  };

  const key = `attendance/${new Date().toISOString().split('T')[0]}/${Date.now()}.json`;

  await withRetry(() =>
    s3.putObject({
      Bucket:      AWS_CONFIG.s3BucketName,
      Key:         key,
      Body:        JSON.stringify(payload),
      ContentType: 'application/json',
    }).promise()
  );

  console.log(`[Sync] Uploaded embeddings to S3: ${key}`);
}

// ── Main sync function ────────────────────────────────────────────────────────

/**
 * Run a full sync cycle.
 *
 * @param onProgress  Optional callback for progress updates
 * @returns           SyncResult with counts
 */
export async function syncAttendanceRecords(
  onProgress?: (progress: SyncProgress) => void,
): Promise<SyncResult> {
  console.log('[Sync] Starting sync...');

  const unsynced = await getUnsyncedRecords();

  if (unsynced.length === 0) {
    console.log('[Sync] Nothing to sync');
    return { success: true, uploaded: 0, failed: 0, purged: 0 };
  }

  console.log(`[Sync] ${unsynced.length} records to upload`);

  const successIds: number[] = [];
  let failed = 0;

  // Upload each record to DynamoDB individually
  // (allows partial success — each record is independent)
  for (let i = 0; i < unsynced.length; i++) {
    const record = unsynced[i];

    onProgress?.({
      total:       unsynced.length,
      current:     i + 1,
      currentName: record.name,
    });

    try {
      await uploadToDynamoDB(record);
      successIds.push(record.id);
    } catch (err: any) {
      // Ignore ConditionalCheckFailedException — record already uploaded
      if (err?.code === 'ConditionalCheckFailedException') {
        successIds.push(record.id);
        console.log(`[Sync] Record ${record.id} already in DynamoDB, skipping`);
      } else {
        console.error(`[Sync] Failed to upload record ${record.id}:`, err);
        failed++;
      }
    }
  }

  // Bulk upload embeddings to S3 (only successful records)
  const successRecords = unsynced.filter(r => successIds.includes(r.id));
  if (successRecords.length > 0) {
    try {
      await uploadToS3(successRecords);
    } catch (err) {
      console.warn('[Sync] S3 upload failed (DynamoDB upload still counts):', err);
    }
  }

  // Mark successful uploads in SQLite
  await markRecordsSynced(successIds);

  // Purge synced records to free storage
  const purged = await purgeSyncedRecords();

  const result: SyncResult = {
    success: failed === 0,
    uploaded: successIds.length,
    failed,
    purged,
  };

  console.log('[Sync] Complete:', result);
  return result;
}

// ── Auto-sync trigger ─────────────────────────────────────────────────────────

/**
 * Call this when NetInfo reports internet connectivity restored.
 * Runs sync silently in background.
 *
 * Gracefully handles the case where the DB hasn't been initialised yet
 * (e.g. first launch — attendance_log table doesn't exist yet).
 * In that scenario we skip silently; the next connectivity event will retry.
 */
export async function autoSync(): Promise<void> {
  try {
    const result = await syncAttendanceRecords();
    if (result.uploaded > 0) {
      console.log(`[AutoSync] Uploaded ${result.uploaded} records`);
    }
  } catch (err: any) {
    // Suppress "no such table" errors that occur before DB migrations have run.
    // This is expected on first launch and resolves itself on the next sync attempt.
    const isTableMissing =
      typeof err?.message === 'string' &&
      err.message.includes('no such table');

    if (isTableMissing) {
      console.log('[AutoSync] DB not ready yet — skipping until next connection');
      return;
    }

    console.warn('[AutoSync] Silent failure (will retry on next connection):', err);
  }
}
