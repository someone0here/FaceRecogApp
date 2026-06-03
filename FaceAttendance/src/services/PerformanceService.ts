/**
 * PerformanceService.ts
 * ====================
 * Monitors and records inference performance metrics.
 * Used for benchmarking and optimization.
 */

export interface InferenceMetrics {
  modelLoadTime?: number;      // ms
  framePreprocessTime?: number; // ms
  embeddingGenerationTime?: number;
  matchingTime?: number;
  totalTime?: number;
  deviceInfo?: string;
  timestamp: string;
}

export interface PerformanceStats {
  avgInferenceTime: number;
  minInferenceTime: number;
  maxInferenceTime: number;
  p95InferenceTime: number;
  recordCount: number;
}

class PerformanceMonitor {
  private metrics: InferenceMetrics[] = [];
  private maxRecords = 1000;

  recordMetric(metric: InferenceMetrics): void {
    this.metrics.push(metric);
    if (this.metrics.length > this.maxRecords) {
      this.metrics = this.metrics.slice(-this.maxRecords);
    }
  }

  getStats(): PerformanceStats {
    if (this.metrics.length === 0) {
      return {
        avgInferenceTime: 0,
        minInferenceTime: 0,
        maxInferenceTime: 0,
        p95InferenceTime: 0,
        recordCount: 0,
      };
    }

    const times = this.metrics
      .map(m => m.totalTime || 0)
      .filter(t => t > 0)
      .sort((a, b) => a - b);

    const avg = times.reduce((a, b) => a + b) / times.length;
    const p95Index = Math.floor(times.length * 0.95);

    return {
      avgInferenceTime: avg,
      minInferenceTime: times[0],
      maxInferenceTime: times[times.length - 1],
      p95InferenceTime: times[p95Index],
      recordCount: this.metrics.length,
    };
  }

  getAllMetrics(): InferenceMetrics[] {
    return [...this.metrics];
  }

  clear(): void {
    this.metrics = [];
  }
}

export const performanceMonitor = new PerformanceMonitor();

/**
 * High-resolution timer for accurate measurements.
 */
export class Timer {
  private startTime: number;

  constructor() {
    this.startTime = performance.now();
  }

  elapsed(): number {
    return Math.round((performance.now() - this.startTime) * 10) / 10;
  }

  reset(): void {
    this.startTime = performance.now();
  }
}
