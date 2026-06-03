/**
 * DatabaseService.ts
 * ==================
 * All SQLite operations for offline storage.
 *
 * Tables:
 *   enrolled_faces  – registered people + their face embeddings
 *   attendance_log  – every verified check-in (synced or pending)
 *
 * Why SQLite?
 *   Works 100% offline, survives app restarts, queryable,
 *   and react-native-sqlite-storage is battle-tested.
 */

import SQLite, {SQLiteDatabase} from 'react-native-sqlite-storage';

// Turn on promise API (instead of callbacks)
SQLite.enablePromise(true);

// ── Types ─────────────────────────────────────────────────────────────────────

export interface EnrolledFace {
  id: number;
  name: string;
  embedding: number[]; // 128-dim float array
  createdAt: string; // ISO timestamp
}

export interface AttendanceRecord {
  id: number;
  name: string;
  confidence: number; // cosine similarity 0–1
  timestamp: string; // ISO timestamp
  synced: 0 | 1; // SQLite has no boolean
  embeddingSnapshot: string; // JSON string of embedding at time of check-in
}

// ── Singleton DB connection ───────────────────────────────────────────────────

let db: SQLiteDatabase | null = null;

async function getDB(): Promise<SQLiteDatabase> {
  if (db) return db;
  db = await SQLite.openDatabase({
    name: 'FaceAttendance.db',
    location: 'default',
  });
  return db;
}

// ── Initialisation ────────────────────────────────────────────────────────────

export async function initDatabase(): Promise<void> {
  const database = await getDB();

  // enrolled_faces: stores each registered person's face embedding
  await database.executeSql(`
    CREATE TABLE IF NOT EXISTS enrolled_faces (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT    NOT NULL,
      embedding   TEXT    NOT NULL,
      created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // attendance_log: every verified check-in event
  await database.executeSql(`
    CREATE TABLE IF NOT EXISTS attendance_log (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      name               TEXT    NOT NULL,
      confidence         REAL    NOT NULL,
      timestamp          TEXT    NOT NULL DEFAULT (datetime('now')),
      synced             INTEGER NOT NULL DEFAULT 0,
      embedding_snapshot TEXT    NOT NULL DEFAULT ''
    );
  `);

  console.log('[DB] Tables ready');
}

// ── Enrolled Faces ────────────────────────────────────────────────────────────

/**
 * Save a new enrolled face to the database.
 * embedding is stored as a JSON string: "[0.12, -0.34, ...]"
 */
export async function saveEnrolledFace(
  name: string,
  embedding: number[],
): Promise<void> {
  const database = await getDB();
  await database.executeSql(
    `INSERT INTO enrolled_faces (name, embedding, created_at)
     VALUES (?, ?, datetime('now'))`,
    [name.trim(), JSON.stringify(embedding)],
  );
  console.log(`[DB] Enrolled: ${name}`);
}

/**
 * Load all enrolled faces.
 * Parses the embedding JSON string back to number[].
 */
export async function getAllEnrolledFaces(): Promise<EnrolledFace[]> {
  const database = await getDB();
  const [result] = await database.executeSql(
    'SELECT * FROM enrolled_faces ORDER BY name ASC',
  );

  const faces: EnrolledFace[] = [];
  for (let i = 0; i < result.rows.length; i++) {
    const row = result.rows.item(i);
    faces.push({
      id: row.id,
      name: row.name,
      embedding: JSON.parse(row.embedding),
      createdAt: row.created_at,
    });
  }
  return faces;
}

/**
 * Delete an enrolled face by id.
 */
export async function deleteEnrolledFace(id: number): Promise<void> {
  const database = await getDB();
  await database.executeSql('DELETE FROM enrolled_faces WHERE id = ?', [id]);
}

// ── Attendance Log ─────────────────────────────────────────────────────────────

/**
 * Save a new attendance record.
 * Called every time a face is successfully recognised.
 */
export async function saveAttendanceRecord(
  name: string,
  confidence: number,
  embedding: number[],
): Promise<void> {
  const database = await getDB();
  await database.executeSql(
    `INSERT INTO attendance_log
       (name, confidence, timestamp, synced, embedding_snapshot)
     VALUES (?, ?, datetime('now'), 0, ?)`,
    [name, confidence, JSON.stringify(embedding)],
  );
  console.log(
    `[DB] Attendance saved: ${name} (${(confidence * 100).toFixed(1)}%)`,
  );
}

/**
 * Get all attendance records, newest first.
 */
export async function getAllAttendanceRecords(): Promise<AttendanceRecord[]> {
  const database = await getDB();
  const [result] = await database.executeSql(
    'SELECT * FROM attendance_log ORDER BY timestamp DESC',
  );

  const records: AttendanceRecord[] = [];
  for (let i = 0; i < result.rows.length; i++) {
    const row = result.rows.item(i);
    records.push({
      id: row.id,
      name: row.name,
      confidence: row.confidence,
      timestamp: row.timestamp,
      synced: row.synced,
      embeddingSnapshot: row.embedding_snapshot,
    });
  }
  return records;
}

/**
 * Get only records that haven't been synced to AWS yet.
 */
export async function getUnsyncedRecords(): Promise<AttendanceRecord[]> {
  const database = await getDB();
  const [result] = await database.executeSql(
    'SELECT * FROM attendance_log WHERE synced = 0 ORDER BY timestamp ASC',
  );

  const records: AttendanceRecord[] = [];
  for (let i = 0; i < result.rows.length; i++) {
    const row = result.rows.item(i);
    records.push({
      id: row.id,
      name: row.name,
      confidence: row.confidence,
      timestamp: row.timestamp,
      synced: row.synced,
      embeddingSnapshot: row.embedding_snapshot,
    });
  }
  return records;
}

/**
 * Mark a list of records as synced (after successful AWS upload).
 */
export async function markRecordsSynced(ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  const database = await getDB();
  const placeholders = ids.map(() => '?').join(', ');
  await database.executeSql(
    `UPDATE attendance_log SET synced = 1 WHERE id IN (${placeholders})`,
    ids,
  );
  console.log(`[DB] Marked ${ids.length} records as synced`);
}

/**
 * Delete synced records to free up local storage (purge step).
 */
export async function purgeSyncedRecords(): Promise<number> {
  const database = await getDB();
  const [result] = await database.executeSql(
    'DELETE FROM attendance_log WHERE synced = 1',
  );
  const deleted = result.rowsAffected ?? 0;
  console.log(`[DB] Purged ${deleted} synced records`);
  return deleted;
}

/**
 * Count of records pending sync — used in the Sync screen badge.
 */
export async function getUnsyncedCount(): Promise<number> {
  const database = await getDB();
  const [result] = await database.executeSql(
    'SELECT COUNT(*) as count FROM attendance_log WHERE synced = 0',
  );
  return result.rows.item(0).count;
}
