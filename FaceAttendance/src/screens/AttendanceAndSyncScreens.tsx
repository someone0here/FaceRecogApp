/**
 * AttendanceLogScreen.tsx
 * =======================
 * Shows all recorded check-ins stored locally in SQLite.
 * Synced records are marked with ☁️, pending ones with 🔴.
 */

import React, {useEffect, useState, useCallback} from 'react';
import {
  View,
  Text,
  FlatList,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  RefreshControl,
  Alert,
} from 'react-native';
import {useFocusEffect} from '@react-navigation/native';
import {
  getAllAttendanceRecords,
  AttendanceRecord,
} from '../services/DatabaseService';

export default function AttendanceLogScreen() {
  const [records, setRecords] = useState<AttendanceRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const loadRecords = useCallback(async () => {
    const data = await getAllAttendanceRecords();
    setRecords(data);
    setLoading(false);
    setRefreshing(false);
  }, []);

  // Reload every time this tab becomes active
  useFocusEffect(
    useCallback(() => {
      loadRecords();
    }, [loadRecords]),
  );

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    loadRecords();
  }, [loadRecords]);

  const formatTime = (iso: string) => {
    try {
      const d = new Date(iso);
      return d.toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'});
    } catch {
      return iso;
    }
  };

  const formatDate = (iso: string) => {
    try {
      return new Date(iso).toLocaleDateString('en-IN', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
      });
    } catch {
      return iso;
    }
  };

  const renderItem = ({item}: {item: AttendanceRecord}) => (
    <View style={styles.row}>
      <View style={styles.rowLeft}>
        <Text style={styles.rowName}>{item.name}</Text>
        <Text style={styles.rowDate}>
          {formatDate(item.timestamp)} · {formatTime(item.timestamp)}
        </Text>
      </View>
      <View style={styles.rowRight}>
        <Text style={styles.confidence}>
          {(item.confidence * 100).toFixed(1)}%
        </Text>
        <Text style={styles.syncBadge}>{item.synced ? '☁️' : '🔴'}</Text>
      </View>
    </View>
  );

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color="#6366f1" size="large" />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {/* Summary bar */}
      <View style={styles.summaryBar}>
        <Text style={styles.summaryText}>
          {records.length} total · 🔴 {records.filter(r => !r.synced).length}{' '}
          pending sync
        </Text>
        <TouchableOpacity onPress={loadRecords}>
          <Text style={styles.refreshBtn}>↺ Refresh</Text>
        </TouchableOpacity>
      </View>

      {records.length === 0 ? (
        <View style={styles.center}>
          <Text style={styles.emptyIcon}>📋</Text>
          <Text style={styles.emptyText}>No attendance records yet</Text>
          <Text style={styles.emptySub}>
            Recognise a face to record attendance
          </Text>
        </View>
      ) : (
        <FlatList
          data={records}
          keyExtractor={item => String(item.id)}
          renderItem={renderItem}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor="#6366f1"
            />
          }
          contentContainerStyle={styles.list}
          ItemSeparatorComponent={() => <View style={styles.separator} />}
        />
      )}
    </View>
  );
}

const logStyles = StyleSheet.create({});

// ══════════════════════════════════════════════════════════════════════════════
/**
 * SyncScreen.tsx
 * ==============
 * Manual sync trigger + auto-sync status display.
 * Shows unsynced count, triggers upload to DynamoDB + S3,
 * then purges local records after confirmation.
 */
// ══════════════════════════════════════════════════════════════════════════════

import {
  syncAttendanceRecords,
  SyncResult,
  SyncProgress,
} from '../services/SyncService';
import {
  getUnsyncedCount,
  getUnsyncedRecords,
} from '../services/DatabaseService';
import NetInfo from '@react-native-community/netinfo';

export function SyncScreen() {
  const [unsyncedCount, setUnsyncedCount] = useState(0);
  const [isOnline, setIsOnline] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [progress, setProgress] = useState<SyncProgress | null>(null);
  const [lastResult, setLastResult] = useState<SyncResult | null>(null);
  const [lastSyncTime, setLastSyncTime] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useFocusEffect(
    useCallback(() => {
      loadStatus();
    }, []),
  );

  const loadStatus = useCallback(async () => {
    setLoading(true);
    const count = await getUnsyncedCount();
    setUnsyncedCount(count);
    const net = await NetInfo.fetch();
    setIsOnline(!!(net.isConnected && net.isInternetReachable));
    setLoading(false);
  }, []);

  // Monitor connectivity
  useEffect(() => {
    const unsub = NetInfo.addEventListener(state => {
      setIsOnline(!!(state.isConnected && state.isInternetReachable));
    });
    return unsub;
  }, []);

  const handleSync = useCallback(async () => {
    if (!isOnline) {
      Alert.alert('No internet', 'Connect to WiFi or mobile data to sync.');
      return;
    }
    setSyncing(true);
    setLastResult(null);
    setProgress(null);

    try {
      const result = await syncAttendanceRecords(p => setProgress(p));
      setLastResult(result);
      setLastSyncTime(new Date().toLocaleTimeString());
      const newCount = await getUnsyncedCount();
      setUnsyncedCount(newCount);
    } catch (err: any) {
      setLastResult({
        success: false,
        uploaded: 0,
        failed: 0,
        purged: 0,
        error: err?.message ?? 'Unknown error',
      });
    } finally {
      setSyncing(false);
      setProgress(null);
    }
  }, [isOnline]);

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color="#6366f1" size="large" />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={syncStyles.content}>
        {/* Network status */}
        <View
          style={[
            syncStyles.netBadge,
            isOnline ? syncStyles.netOnline : syncStyles.netOffline,
          ]}>
          <Text style={syncStyles.netText}>
            {isOnline ? '🌐  Connected' : '📵  Offline'}
          </Text>
        </View>

        {/* Pending records count */}
        <View style={syncStyles.countCard}>
          <Text style={syncStyles.countNumber}>{unsyncedCount}</Text>
          <Text style={syncStyles.countLabel}>records pending sync</Text>
        </View>

        {/* AWS destination info */}
        <View style={syncStyles.destinationCard}>
          <Text style={syncStyles.destinationTitle}>Sync destination</Text>
          <Text style={syncStyles.destinationRow}>
            📊 DynamoDB — attendance metadata
          </Text>
          <Text style={syncStyles.destinationRow}>
            🗄 S3 — embedding snapshots
          </Text>
          <Text style={syncStyles.destinationRow}>
            🌏 Region — ap-south-1 (Mumbai)
          </Text>
        </View>

        {/* Progress bar */}
        {syncing && progress && (
          <View style={syncStyles.progressWrap}>
            <Text style={syncStyles.progressText}>
              Uploading {progress.currentName}... ({progress.current}/
              {progress.total})
            </Text>
            <View style={syncStyles.progressBar}>
              <View
                style={[
                  syncStyles.progressFill,
                  {width: `${(progress.current / progress.total) * 100}%`},
                ]}
              />
            </View>
          </View>
        )}

        {/* Last result */}
        {lastResult && !syncing && (
          <View
            style={[
              syncStyles.resultCard,
              lastResult.success ? syncStyles.resultOk : syncStyles.resultErr,
            ]}>
            {lastResult.success ? (
              <>
                <Text style={syncStyles.resultTitle}>☁️ Sync complete</Text>
                <Text style={syncStyles.resultDetail}>
                  ✅ Uploaded: {lastResult.uploaded}
                  {'\n'}
                  🗑 Purged: {lastResult.purged}
                  {'\n'}
                  🕐 At: {lastSyncTime}
                </Text>
              </>
            ) : (
              <>
                <Text style={syncStyles.resultTitle}>❌ Sync failed</Text>
                <Text style={syncStyles.resultDetail}>
                  {lastResult.error ?? 'Partial failure — will retry next sync'}
                  {'\n'}Uploaded: {lastResult.uploaded}, Failed:{' '}
                  {lastResult.failed}
                </Text>
              </>
            )}
          </View>
        )}

        {/* Sync button */}
        <TouchableOpacity
          style={[
            syncStyles.syncBtn,
            (!isOnline || syncing || unsyncedCount === 0) && styles.btnDisabled,
          ]}
          onPress={handleSync}
          disabled={!isOnline || syncing || unsyncedCount === 0}>
          {syncing ? (
            <>
              <ActivityIndicator color="#fff" style={{marginRight: 8}} />
              <Text style={syncStyles.syncBtnText}>Syncing...</Text>
            </>
          ) : (
            <Text style={syncStyles.syncBtnText}>
              ☁️ Sync{' '}
              {unsyncedCount > 0
                ? `${unsyncedCount} Records`
                : '(nothing pending)'}
            </Text>
          )}
        </TouchableOpacity>

        {unsyncedCount === 0 && !syncing && (
          <Text style={syncStyles.allGoodText}>✅ All records synced</Text>
        )}

        <TouchableOpacity style={syncStyles.refreshLink} onPress={loadStatus}>
          <Text style={syncStyles.refreshLinkText}>↺ Refresh status</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

// ── Shared styles ─────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  container: {flex: 1, backgroundColor: '#111827'},
  center: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#111827',
  },
  // Attendance log
  summaryBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#374151',
  },
  summaryText: {color: '#9ca3af', fontSize: 13},
  refreshBtn: {color: '#6366f1', fontSize: 14, fontWeight: '600'},
  list: {padding: 12},
  row: {
    backgroundColor: '#1f2937',
    borderRadius: 12,
    padding: 14,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  rowLeft: {flex: 1},
  rowName: {color: '#f9fafb', fontSize: 16, fontWeight: '700'},
  rowDate: {color: '#9ca3af', fontSize: 13, marginTop: 2},
  rowRight: {alignItems: 'flex-end'},
  confidence: {color: '#6366f1', fontSize: 14, fontWeight: '700'},
  syncBadge: {fontSize: 18, marginTop: 4},
  separator: {height: 8},
  emptyIcon: {fontSize: 52, marginBottom: 12},
  emptyText: {
    color: '#f9fafb',
    fontSize: 18,
    fontWeight: '600',
    marginBottom: 6,
  },
  emptySub: {color: '#9ca3af', fontSize: 14},
  btnDisabled: {opacity: 0.4},
});

const syncStyles = StyleSheet.create({
  content: {flex: 1, padding: 24},
  netBadge: {
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 8,
    alignSelf: 'flex-start',
    marginBottom: 24,
  },
  netOnline: {backgroundColor: '#064e3b'},
  netOffline: {backgroundColor: '#450a0a'},
  netText: {color: '#f9fafb', fontSize: 14, fontWeight: '700'},
  countCard: {
    backgroundColor: '#1f2937',
    borderRadius: 16,
    padding: 28,
    alignItems: 'center',
    marginBottom: 16,
  },
  countNumber: {fontSize: 56, fontWeight: '800', color: '#6366f1'},
  countLabel: {color: '#9ca3af', fontSize: 15, marginTop: 4},
  destinationCard: {
    backgroundColor: '#1f2937',
    borderRadius: 12,
    padding: 16,
    marginBottom: 20,
  },
  destinationTitle: {
    color: '#9ca3af',
    fontSize: 12,
    fontWeight: '700',
    marginBottom: 10,
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  destinationRow: {color: '#d1d5db', fontSize: 14, marginBottom: 6},
  progressWrap: {marginBottom: 16},
  progressText: {color: '#a5b4fc', fontSize: 13, marginBottom: 6},
  progressBar: {height: 6, backgroundColor: '#374151', borderRadius: 3},
  progressFill: {height: 6, backgroundColor: '#6366f1', borderRadius: 3},
  resultCard: {borderRadius: 12, padding: 16, marginBottom: 16},
  resultOk: {backgroundColor: '#064e3b'},
  resultErr: {backgroundColor: '#450a0a'},
  resultTitle: {
    color: '#f9fafb',
    fontSize: 16,
    fontWeight: '700',
    marginBottom: 8,
  },
  resultDetail: {color: '#d1d5db', fontSize: 14, lineHeight: 22},
  syncBtn: {
    backgroundColor: '#6366f1',
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'center',
    marginBottom: 12,
  },
  syncBtnText: {color: '#fff', fontSize: 17, fontWeight: '700'},
  allGoodText: {
    color: '#22c55e',
    fontSize: 15,
    textAlign: 'center',
    marginBottom: 12,
  },
  refreshLink: {alignItems: 'center', paddingVertical: 8},
  refreshLinkText: {color: '#6b7280', fontSize: 14},
});
