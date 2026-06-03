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

const styles = StyleSheet.create({
  container: {flex: 1, backgroundColor: '#111827'},
  center: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#111827',
  },
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
});
