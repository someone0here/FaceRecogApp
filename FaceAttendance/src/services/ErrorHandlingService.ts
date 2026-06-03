/**
 * ErrorHandlingService.ts
 * ======================
 * Centralized error handling, user-friendly messages, and recovery suggestions.
 */

export enum ErrorSeverity {
  INFO = 'info',
  WARNING = 'warning',
  ERROR = 'error',
  CRITICAL = 'critical',
}

export interface AppError {
  code: string;
  message: string;
  userMessage: string;
  severity: ErrorSeverity;
  recoveryAction?: string;
  originalError?: Error;
  context?: Record<string, any>;
}

export const ERROR_CATALOG = {
  // Camera errors
  CAMERA_PERMISSION_DENIED: {
    message: 'Camera permission was denied',
    userMessage: 'Please grant camera permission in settings',
    recoveryAction: 'Settings',
    severity: ErrorSeverity.ERROR,
  },
  CAMERA_NOT_AVAILABLE: {
    message: 'Front camera not available',
    userMessage: 'Your device does not have a front camera',
    severity: ErrorSeverity.CRITICAL,
  },
  CAMERA_CAPTURE_FAILED: {
    message: 'Failed to capture photo',
    userMessage: 'Photo capture failed. Please try again.',
    recoveryAction: 'Retry',
    severity: ErrorSeverity.WARNING,
  },

  // Model errors
  MODEL_LOAD_FAILED: {
    message: 'Failed to load face recognition model',
    userMessage: 'App initialization failed. Please restart the app.',
    severity: ErrorSeverity.CRITICAL,
  },
  MODEL_NOT_READY: {
    message: 'Model still loading',
    userMessage: 'Please wait for the model to load...',
    severity: ErrorSeverity.INFO,
  },
  INFERENCE_FAILED: {
    message: 'Face recognition inference failed',
    userMessage: 'Recognition failed. Please try again.',
    recoveryAction: 'Retry',
    severity: ErrorSeverity.WARNING,
  },

  // Database errors
  DB_INIT_FAILED: {
    message: 'Database initialization failed',
    userMessage: 'Storage setup failed. Please restart the app.',
    severity: ErrorSeverity.CRITICAL,
  },
  DB_QUERY_FAILED: {
    message: 'Database query failed',
    userMessage: 'Data access failed. Please try again.',
    recoveryAction: 'Retry',
    severity: ErrorSeverity.WARNING,
  },

  // Sync errors
  SYNC_NO_NETWORK: {
    message: 'No internet connection',
    userMessage: 'Cannot sync. Check your internet connection.',
    severity: ErrorSeverity.INFO,
  },
  SYNC_TIMEOUT: {
    message: 'Sync operation timed out',
    userMessage: 'Upload timed out. Will retry when connected.',
    recoveryAction: 'Retry',
    severity: ErrorSeverity.WARNING,
  },
  SYNC_FAILED: {
    message: 'Sync failed',
    userMessage: 'Failed to upload records. Will retry later.',
    recoveryAction: 'Retry',
    severity: ErrorSeverity.WARNING,
  },

  // Enrollment errors
  ENROLL_FACE_NOT_DETECTED: {
    message: 'No face detected in photo',
    userMessage: 'Face not detected. Please try again.',
    recoveryAction: 'Retry',
    severity: ErrorSeverity.WARNING,
  },
  ENROLL_FACE_TOO_SMALL: {
    message: 'Face too small in frame',
    userMessage: 'Please move closer to the camera',
    recoveryAction: 'Retry',
    severity: ErrorSeverity.INFO,
  },
  ENROLL_MULTIPLE_FACES: {
    message: 'Multiple faces detected',
    userMessage: 'Please ensure only one face is in the frame',
    recoveryAction: 'Retry',
    severity: ErrorSeverity.INFO,
  },

  // Recognition errors
  RECOGNITION_NO_MATCH: {
    message: 'No matching face found',
    userMessage: 'Face not recognized',
    severity: ErrorSeverity.INFO,
  },
  RECOGNITION_LOW_CONFIDENCE: {
    message: 'Recognition confidence too low',
    userMessage: 'Face not clearly recognized. Please try again.',
    recoveryAction: 'Retry',
    severity: ErrorSeverity.INFO,
  },

  // Unknown error
  UNKNOWN_ERROR: {
    message: 'An unexpected error occurred',
    userMessage: 'Something went wrong. Please try again.',
    recoveryAction: 'Retry',
    severity: ErrorSeverity.ERROR,
  },
};

export class ErrorHandler {
  static createError(
    code: keyof typeof ERROR_CATALOG,
    context?: Record<string, any>,
    originalError?: Error,
  ): AppError {
    const catalog = ERROR_CATALOG[code] || ERROR_CATALOG.UNKNOWN_ERROR;
    return {
      code,
      message: catalog.message,
      userMessage: catalog.userMessage,
      severity: catalog.severity,
      recoveryAction: catalog.recoveryAction,
      originalError,
      context,
    };
  }

  static log(error: AppError): void {
    console.error(`[${error.code}] ${error.message}`, error.context);
  }

  static isRecoverable(error: AppError): boolean {
    return error.severity !== ErrorSeverity.CRITICAL;
  }

  static getRecoveryAction(error: AppError): string | undefined {
    return error.recoveryAction;
  }
}
