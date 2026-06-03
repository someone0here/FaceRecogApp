/**
 * AppNavigator.tsx
 * ================
 * Bottom tab navigation connecting all 4 screens.
 * Uses React Navigation v6 with bottom tabs.
 */

import React from 'react';
import {View, Text, StyleSheet} from 'react-native';
import {NavigationContainer} from '@react-navigation/native';
import {createBottomTabNavigator} from '@react-navigation/bottom-tabs';

import EnrollmentScreen from '../screens/EnrollmentScreen';
import RecognitionScreen from '../screens/RecognitionScreen';
import AttendanceLogScreen from '../screens/AttendanceLogScreen';
import {SyncScreen} from '../screens/SyncScreen';

const Tab = createBottomTabNavigator();

// Simple icon component using emoji (no icon library dependency)
function TabIcon({emoji, focused}: {emoji: string; focused: boolean}) {
  return (
    <View style={styles.iconWrap}>
      <Text style={[styles.emoji, focused && styles.emojiActive]}>{emoji}</Text>
    </View>
  );
}

export default function AppNavigator() {
  return (
    <NavigationContainer>
      <Tab.Navigator
        screenOptions={{
          tabBarStyle: styles.tabBar,
          tabBarLabelStyle: styles.tabLabel,
          tabBarActiveTintColor: '#6366f1',
          tabBarInactiveTintColor: '#9ca3af',
          headerStyle: styles.header,
          headerTitleStyle: styles.headerTitle,
          headerTintColor: '#f9fafb',
        }}>
        <Tab.Screen
          name="Enroll"
          component={EnrollmentScreen}
          options={{
            title: 'Enroll',
            headerTitle: '📸  Enroll New Face',
            tabBarIcon: ({focused}) => <TabIcon emoji="👤" focused={focused} />,
          }}
        />

        <Tab.Screen
          name="Recognise"
          component={RecognitionScreen}
          options={{
            title: 'Recognise',
            headerTitle: '🔍  Face Recognition',
            tabBarIcon: ({focused}) => <TabIcon emoji="🔍" focused={focused} />,
          }}
        />

        <Tab.Screen
          name="Attendance"
          component={AttendanceLogScreen}
          options={{
            title: 'Log',
            headerTitle: '📋  Attendance Log',
            tabBarIcon: ({focused}) => <TabIcon emoji="📋" focused={focused} />,
          }}
        />

        <Tab.Screen
          name="Sync"
          component={SyncScreen}
          options={{
            title: 'Sync',
            headerTitle: '☁️  Sync to AWS',
            tabBarIcon: ({focused}) => <TabIcon emoji="☁️" focused={focused} />,
          }}
        />
      </Tab.Navigator>
    </NavigationContainer>
  );
}

const styles = StyleSheet.create({
  tabBar: {
    backgroundColor: '#1f2937',
    borderTopColor: '#374151',
    borderTopWidth: 1,
    height: 60,
    paddingBottom: 6,
    paddingTop: 4,
  },
  tabLabel: {
    fontSize: 11,
    fontWeight: '600',
  },
  header: {
    backgroundColor: '#111827',
    elevation: 0,
    shadowOpacity: 0,
  },
  headerTitle: {
    color: '#f9fafb',
    fontSize: 17,
    fontWeight: '700',
  },
  iconWrap: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  emoji: {
    fontSize: 20,
    opacity: 0.5,
  },
  emojiActive: {
    opacity: 1,
  },
});
