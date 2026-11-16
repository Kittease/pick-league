/**
 * Confidence levels of the API's 0..1 sample-size confidence, and the minimum-confidence filter
 * shared by the tier list (and its matchups), the champion select picks and the draft planner.
 */

export const CONFIDENCE_LEVELS = ['LOW', 'MEDIUM', 'HIGH'] as const;
export type ConfidenceLevel = (typeof CONFIDENCE_LEVELS)[number];

/** Lowest confidence of each level. */
const THRESHOLD: Record<ConfidenceLevel, number> = { LOW: 0, MEDIUM: 0.4, HIGH: 0.75 };

export function confidenceLevel(confidence: number): ConfidenceLevel {
  if (confidence >= THRESHOLD.HIGH) return 'HIGH';
  if (confidence >= THRESHOLD.MEDIUM) return 'MEDIUM';
  return 'LOW';
}

/** Whether a 0..1 confidence passes the minimum level (`LOW` lets everything through). */
export function meetsConfidence(confidence: number, min: ConfidenceLevel): boolean {
  return min === 'LOW' || confidence >= THRESHOLD[min];
}

/** Labels of the filter. */
export const MIN_CONFIDENCE_LABEL: Record<ConfidenceLevel, string> = {
  LOW: 'Low+ confidence',
  MEDIUM: 'Medium+ confidence',
  HIGH: 'High confidence',
};

export const DEFAULT_MIN_CONFIDENCE: ConfidenceLevel = 'LOW';

/** A level from untrusted input (local storage): anything else is the default. */
export function toConfidenceLevel(value: unknown): ConfidenceLevel {
  return CONFIDENCE_LEVELS.includes(value as ConfidenceLevel)
    ? (value as ConfidenceLevel)
    : DEFAULT_MIN_CONFIDENCE;
}
