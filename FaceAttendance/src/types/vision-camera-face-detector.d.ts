declare module 'vision-camera-face-detector' {
  import type {Frame} from 'react-native-vision-camera';

  export type FaceDetectionOptions = {
    performanceMode?: 'fast' | 'accurate';
    classificationMode?: 'none' | 'all';
  };

  export type DetectedFace = {
    leftEyeOpenProbability?: number;
    rightEyeOpenProbability?: number;
    smilingProbability?: number;
    [key: string]: any;
  };

  export function useFaceDetector(options: FaceDetectionOptions): {
    detectFaces: (frame: Frame) => DetectedFace[];
  };
}
