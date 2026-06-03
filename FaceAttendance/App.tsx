/**
 * App.tsx
 * =======
 * Root component. Initialises the database and warms up the AI model
 * before rendering the navigation. Also sets up auto-sync on reconnect.
 */

import React, { useEffect, useState } from 'react';
import { View, Text, ActivityIndicator, StyleSheet } from 'react-native';
import NetInfo from '@react-native-community/netinfo';

import { initDatabase }  from './src/services/DatabaseService';
import { loadFaceModel } from './src/services/FaceRecognitionService';
import { autoSync }      from './src/services/SyncService';
import AppNavigator      from './src/navigation/AppNavigator';

export default function App() {
  const [ready, setReady]         = useState(false);
  const [statusMsg, setStatusMsg] = useState('Starting...');

  useEffect(() => {
    (async () => {
      try {
        setStatusMsg('Initialising database...');
        await initDatabase();

        setStatusMsg('Loading AI model...');
        try {
          await loadFaceModel();
          setStatusMsg('Ready!');
        } catch (modelErr) {
          // TFLite JSI is not available on iOS simulator — continue anyway.
          // Face recognition features will show an error when used,
          // but navigation and DB features work fine.
          console.warn('[App] TFLite model failed to load (expected on iOS simulator):', modelErr);
          setStatusMsg('Ready (simulator mode — face recognition unavailable)');
        }

        setReady(true);
      } catch (err) {
        console.error('[App] Boot error:', err);
        setStatusMsg('Error starting app. Please restart.');
        // Still proceed to app so UI is accessible
        setReady(true);
      }
    })();
  }, []);

  useEffect(() => {
    const unsub = NetInfo.addEventListener(state => {
      if (state.isConnected && state.isInternetReachable) {
        autoSync();
      }
    });
    return unsub;
  }, []);

  if (!ready) {
    return (
      <View style={styles.splash}>
        <Text style={styles.splashTitle}>FaceAttend</Text>
        <Text style={styles.splashSub}>Offline Face Recognition</Text>
        <ActivityIndicator
          color="#6366f1"
          size="large"
          style={styles.spinner}
        />
        <Text style={styles.splashStatus}>{statusMsg}</Text>
      </View>
    );
  }

  return <AppNavigator />;
}

const styles = StyleSheet.create({
  splash: {
    flex: 1,
    backgroundColor: '#111827',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 40,
  },
  splashTitle: {
    fontSize: 36,
    fontWeight: '800',
    color: '#f9fafb',
    marginBottom: 8,
    letterSpacing: -0.5,
  },
  splashSub: {
    fontSize: 16,
    color: '#9ca3af',
    marginBottom: 48,
  },
  spinner: {
    marginBottom: 20,
  },
  splashStatus: {
    fontSize: 14,
    color: '#6b7280',
  },
});
