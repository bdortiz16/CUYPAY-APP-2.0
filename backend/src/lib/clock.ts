import { randomBytes } from 'node:crypto';

/** Reloj inyectable (los tests usan FakeClock para límites, TTLs y desfases). */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export class FakeClock implements Clock {
  private t: number;
  constructor(start: Date | string | number = '2026-11-07T15:00:00.000Z') {
    this.t = new Date(start).getTime();
  }
  now(): Date {
    return new Date(this.t);
  }
  set(d: Date | string | number): void {
    this.t = new Date(d).getTime();
  }
  advance(ms: number): void {
    this.t += ms;
  }
  advanceSeconds(s: number): void {
    this.t += s * 1000;
  }
}

const B32 = '0123456789abcdefghjkmnpqrstvwxyz';
let seq = 0;

/**
 * IDs con prefijo, ordenables por tiempo: `usr_` + 10 chars de tiempo + 4 de secuencia
 * monotónica (desempata IDs del mismo milisegundo) + 8 aleatorios.
 */
export function newId(prefix: string, at: Date = new Date()): string {
  let t = at.getTime();
  let time = '';
  for (let i = 0; i < 10; i++) {
    time = B32[t % 32] + time;
    t = Math.floor(t / 32);
  }
  seq = (seq + 1) % 32 ** 4;
  let s = seq;
  let counter = '';
  for (let i = 0; i < 4; i++) {
    counter = B32[s % 32] + counter;
    s = Math.floor(s / 32);
  }
  const rnd = randomBytes(8);
  let r = '';
  for (const b of rnd) r += B32[b % 32];
  return `${prefix}_${time}${counter}${r}`;
}

export const toIso = (d: Date): string => d.toISOString();
