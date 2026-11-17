import { describe, expect, test } from 'bun:test';
import { confidenceLevel, meetsConfidence, toConfidenceLevel } from './confidence';

describe('confidenceLevel', () => {
  test('splits at 0.4 and 0.75', () => {
    expect(confidenceLevel(0)).toBe('LOW');
    expect(confidenceLevel(0.399)).toBe('LOW');
    expect(confidenceLevel(0.4)).toBe('MEDIUM');
    expect(confidenceLevel(0.749)).toBe('MEDIUM');
    expect(confidenceLevel(0.75)).toBe('HIGH');
    expect(confidenceLevel(1)).toBe('HIGH');
  });
});

describe('meetsConfidence', () => {
  test('Low+ keeps everything', () => {
    expect(meetsConfidence(0, 'LOW')).toBe(true);
  });

  test('Medium+ keeps medium and high', () => {
    expect(meetsConfidence(0.39, 'MEDIUM')).toBe(false);
    expect(meetsConfidence(0.4, 'MEDIUM')).toBe(true);
    expect(meetsConfidence(0.9, 'MEDIUM')).toBe(true);
  });

  test('High keeps high only', () => {
    expect(meetsConfidence(0.74, 'HIGH')).toBe(false);
    expect(meetsConfidence(0.75, 'HIGH')).toBe(true);
  });
});

describe('toConfidenceLevel', () => {
  test('keeps a known level, defaults anything else to High', () => {
    expect(toConfidenceLevel('LOW')).toBe('LOW');
    expect(toConfidenceLevel('low')).toBe('HIGH');
    expect(toConfidenceLevel(null)).toBe('HIGH');
  });
});
