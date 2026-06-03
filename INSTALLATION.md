# 🚀 Installation & Setup Guide

> Complete setup instructions for FaceRecogApp development and deployment

---

## Table of Contents

- [Prerequisites](#prerequisites)
- [Development Setup](#development-setup)
- [Running on Devices](#running-on-devices)
- [Troubleshooting](#troubleshooting)
- [Configuration](#configuration)

---

## Prerequisites

### System Requirements

- **macOS 11+** or **Windows 10+** or **Linux (Ubuntu 18+)**
- **Node.js 16+** (recommended: 18 or 20 LTS)
- **npm 8+** or **yarn 3+**
- **Git**

### For Android Development

- **Android Studio 4.2+** or **Android SDK CLI**
- **Java Development Kit (JDK) 11+**
- **Android SDK API Level 24+**
- **Android Emulator or physical device** with USB debugging enabled

### For iOS Development (macOS only)

- **Xcode 14+**
- **CocoaPods 1.11+**
- **iOS 13+ deployment target**

### Recommended Development Tools

- **Visual Studio Code** with React Native extension
- **Android Emulator** (built-in with Android Studio)
- **iOS Simulator** (built-in with Xcode)

---

## Development Setup

### 1. Clone Repository

```bash
git clone https://github.com/GITHUB_USERNAME/FaceRecogApp.git
cd FaceRecogApp
```

### 2. Install Node Dependencies

```bash
npm install
# or
yarn install
```

**Expected**: Installs React Native, TypeScript, TensorFlow Lite, and all dependencies (may take 5-10 minutes).

### 3. Verify Installation

```bash
npm list react-native
npm list typescript
npm list @react-native-camera/camera
```

All should return version information without errors.

### 4. (macOS/iOS Only) Install Pod Dependencies

```bash
cd FaceAttendance/ios
pod install
cd ../..
```

---

## Running on Devices

### Option 1: Android Emulator

**Start the Metro bundler** (Terminal 1):

```bash
npx react-native start --reset-cache
```

Wait for the message: `Metro has started`

**Launch app** (Terminal 2):

```bash
npx react-native run-android
```

The app will compile and launch on the Android Emulator.

### Option 2: Android Physical Device

1. **Enable USB Debugging** on your Android device:
   - Settings → About Phone → tap Build Number 7 times
   - Settings → Developer Options → enable USB Debugging

2. **Connect device** via USB

3. **Verify connection**:

   ```bash
   adb devices
   ```

   Device should show in list.

4. **Start Metro** (Terminal 1):

   ```bash
   npx react-native start --reset-cache
   ```

5. **Launch app** (Terminal 2):
   ```bash
   npx react-native run-android
   ```

### Option 3: iOS Simulator (macOS only)

**Start Metro** (Terminal 1):

```bash
npx react-native start --reset-cache
```

**Launch app** (Terminal 2):

```bash
npx react-native run-ios
```

Default simulator is iPhone 14. To specify:

```bash
npx react-native run-ios --simulator="iPhone 15 Pro"
```

### Option 4: iOS Physical Device (macOS only)

1. **Select device in Xcode**:

   ```bash
   open FaceAttendance/ios/FaceAttendance.xcworkspace
   ```

2. **In Xcode**: Select your device from the top menu

3. **Build & Run**: Press ⌘R or Product → Run

4. **Trust Developer Certificate** on device if prompted

---

## Troubleshooting

### Metro Bundler Issues

**Problem**: `Metro bundler crashes or freezes`

**Solution**:

```bash
npx react-native start --reset-cache
# Then try again
```

For persistent issues:

```bash
rm -rf node_modules
rm package-lock.json
npm install
```

### Android Build Failures

**Problem**: `Android SDK not found`

**Solution**:

```bash
export ANDROID_HOME=~/Library/Android/sdk
export PATH=$PATH:$ANDROID_HOME/emulator
export PATH=$PATH:$ANDROID_HOME/tools
```

Or set in your shell profile (`.bash_profile`, `.zshrc`).

**Problem**: `Android Emulator won't start`

**Solution**:

```bash
# List available emulators
emulator -list-avds

# Start emulator
emulator -avd <emulator_name>
```

### iOS Pod Issues

**Problem**: `CocoaPods dependency errors`

**Solution**:

```bash
cd FaceAttendance/ios
rm -rf Pods Podfile.lock
pod repo update
pod install
cd ../..
```

### Camera Permission Issues

**Android**: Add to `AndroidManifest.xml` (usually auto-configured):

```xml
<uses-permission android:name="android.permission.CAMERA" />
```

**iOS**: Add to `Info.plist`:

```xml
<key>NSCameraUsageDescription</key>
<string>We need camera access for facial recognition</string>
```

### TensorFlow Lite Model Loading

**Problem**: `Model loading failed or inference crashes`

**Solution**:

1. Verify model files exist in `ai_model/tflite_models/`
2. Check model file permissions: `ls -la ai_model/tflite_models/`
3. Ensure model is included in app bundle (check Xcode build phases or Android gradle config)

---

## Configuration

### Environment Variables

Copy template:

```bash
cp .env.example .env
```

Edit `.env`:

```env
# AWS Configuration (optional, for cloud sync)
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=your_access_key
AWS_SECRET_ACCESS_KEY=your_secret_key

# API Configuration
API_TIMEOUT=30000
LOG_LEVEL=info

# Feature Flags
ENABLE_CLOUD_SYNC=false
ENABLE_ENCRYPTION=true
```

### Model Configuration

Models are pre-bundled in the app. To use custom models:

1. Place TensorFlow Lite models in `ai_model/tflite_models/`
2. Update model path in app code (see `ARCHITECTURE.md`)
3. Rebuild and redeploy

---

## Development Workflow

### Code Changes & Hot Reload

Metro supports **Fast Refresh** (hot reload):

```bash
# While Metro is running:
# Edit your code and save
# Changes appear on device automatically (usually within 2 seconds)
```

If Fast Refresh fails, press `r` in Metro terminal to reload, or rebuild.

### Running Tests

```bash
# Run all tests
npm test

# Run tests in watch mode
npm test -- --watch

# Run specific test file
npm test -- __tests__/MyComponent.test.tsx
```

### Building for Production

**Android APK**:

```bash
cd FaceAttendance/android
./gradlew assembleRelease
# Output: app/build/outputs/apk/release/app-release.apk
```

**Android AAB** (Google Play format):

```bash
./gradlew bundleRelease
# Output: app/build/outputs/bundle/release/app-release.aab
```

**iOS IPA** (via Xcode):

```bash
cd FaceAttendance/ios
xcodebuild -workspace FaceAttendance.xcworkspace \
  -scheme FaceAttendance \
  -configuration Release \
  -archivePath build/FaceAttendance.xcarchive \
  archive
```

---

## Performance Optimization

### For Development

```bash
# Disable development-only features for faster builds
npx react-native start --reset-cache --no-generate-source-map
```

### For Production

1. Enable ProGuard/R8 for Android (configured in gradle)
2. Enable BitCode for iOS (Xcode settings)
3. Strip unused code and assets
4. Optimize assets and images

---

## Next Steps

1. **Read [ARCHITECTURE.md](ARCHITECTURE.md)** for technical deep dive
2. **Check [CONTRIBUTING.md](CONTRIBUTING.md)** for development guidelines
3. **Run the app** and test enrollment/recognition flows
4. **Review code** in `FaceAttendance/src/` directory
5. **Explore ML models** in `ai_model/` directory

---

## Support

Having issues? Check:

1. [Troubleshooting](#troubleshooting) section above
2. [ARCHITECTURE.md](ARCHITECTURE.md) for technical details
3. React Native documentation: https://reactnative.dev/
4. TensorFlow Lite documentation: https://www.tensorflow.org/lite

---

**Happy coding! 🚀**
