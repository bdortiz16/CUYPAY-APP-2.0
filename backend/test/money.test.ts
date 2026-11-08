import { describe, expect, it } from 'vitest';
import {
  RATE_SCALE,
  applySpread,
  computeFee,
  convertMinor,
  formatRate,
  invertRate,
  majorStringToMinor,
  minorToMajorString,
  parseRate,
} from '../src/lib/money.js';
import { localDate, periodRange } from '../src/lib/time.js';

describe('FX con enteros', () => {
  it('parse/format de tasas sin floats', () => {
    expect(parseRate('0.0013003')).toBe(13_003_000n);
    expect(formatRate(13_003_000n)).toBe('0.0013003');
    expect(parseRate('1')).toBe(RATE_SCALE);
    expect(formatRate(parseRate('769.05'))).toBe('769.05');
    expect(parseRate('0.123456789012345')).toBe(1_234_567_890n); // trunca a 10 decimales
  });

  it('toAmountMinor = floor((from - fee) * rate)', () => {
    const rate = parseRate('0.0013003');
    // (100000000 - 1000000) * 0.0013003 = 128729.7 → 128729
    expect(convertMinor(100_000_000n, 1_000_000n, rate)).toBe(128_729n);
    // floor también con decimales exactos
    expect(convertMinor(1000n, 0n, parseRate('0.5'))).toBe(500n);
    expect(convertMinor(999n, 0n, parseRate('0.5'))).toBe(499n);
    expect(convertMinor(10n, 10n, rate)).toBe(0n);
  });

  it('spread y comisión en bps con floor', () => {
    const mid = parseRate('0.0013200');
    expect(applySpread(mid, 150)).toBe(13_002_000n); // 0.0013002
    expect(applySpread(mid, 0)).toBe(mid);
    expect(computeFee(100_000_000n, 100, 0)).toBe(1_000_000n);
    expect(computeFee(99n, 100, 0)).toBe(0n);
    expect(computeFee(99n, 100, 50)).toBe(50n);
  });

  it('inversa y conversión de unidades', () => {
    expect(formatRate(invertRate(parseRate('0.002')))).toBe('500');
    expect(minorToMajorString(15_000_000n)).toBe('150000.00');
    expect(minorToMajorString(5n)).toBe('0.05');
    expect(majorStringToMinor('150000.5')).toBe(15_000_050n);
    expect(majorStringToMinor('150000')).toBe(15_000_000n);
    expect(majorStringToMinor('1.239')).toBe(123n);
  });

  it('no pierde precisión con montos grandes', () => {
    const big = 900_000_000_000_000n; // > 2^53 en intermedios
    expect(convertMinor(big, 0n, parseRate('0.0013003'))).toBe(1_170_270_000_000n);
  });
});

describe('periodos calendario America/Bogota', () => {
  it('día local: 23:30 Bogotá (04:30Z) sigue siendo el día anterior en UTC', () => {
    const at = new Date('2026-11-08T04:30:00Z'); // 2026-11-07 23:30 en Bogotá
    expect(localDate(at)).toBe('2026-11-07');
    const { start, end } = periodRange(at, 'daily');
    expect(start.toISOString()).toBe('2026-11-07T05:00:00.000Z');
    expect(end.toISOString()).toBe('2026-11-08T05:00:00.000Z');
  });

  it('mes y año calendario', () => {
    const at = new Date('2026-12-31T23:00:00Z'); // 18:00 del 31-dic en Bogotá
    const m = periodRange(at, 'monthly');
    expect(m.start.toISOString()).toBe('2026-12-01T05:00:00.000Z');
    expect(m.end.toISOString()).toBe('2027-01-01T05:00:00.000Z');
    const y = periodRange(new Date('2027-01-01T03:00:00Z'), 'annual'); // aún 2026 en Bogotá
    expect(y.start.toISOString()).toBe('2026-01-01T05:00:00.000Z');
    expect(y.end.toISOString()).toBe('2027-01-01T05:00:00.000Z');
  });
});
