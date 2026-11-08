/**
 * Periodos calendario en una zona horaria (por defecto America/Bogota).
 * Colombia no tiene horario de verano (UTC-5), pero se calcula con Intl para no
 * depender de esa suposición.
 */
export const BOGOTA_TZ = 'America/Bogota';
export type Period = 'daily' | 'monthly' | 'annual';

function zonedParts(date: Date, timeZone: string) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

/** Offset (ms) de la zona respecto a UTC en un instante dado (Bogotá = -5h). */
export function tzOffsetMs(date: Date, timeZone: string): number {
  const p = zonedParts(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** Instante UTC correspondiente a la medianoche local Y-M-D en la zona. */
function zonedMidnight(year: number, month: number, day: number, timeZone: string): Date {
  const guess = new Date(Date.UTC(year, month - 1, day));
  const off = tzOffsetMs(guess, timeZone);
  const candidate = new Date(guess.getTime() - off);
  // Reajuste por si el offset cambia en ese intervalo (no aplica a Bogotá).
  const off2 = tzOffsetMs(candidate, timeZone);
  return off2 === off ? candidate : new Date(guess.getTime() - off2);
}

/** Inicio (inclusive) y fin (exclusivo) del periodo calendario que contiene `at`. */
export function periodRange(at: Date, period: Period, timeZone = BOGOTA_TZ): { start: Date; end: Date } {
  const p = zonedParts(at, timeZone);
  switch (period) {
    case 'daily': {
      const start = zonedMidnight(p.year, p.month, p.day, timeZone);
      const next = new Date(Date.UTC(p.year, p.month - 1, p.day + 1));
      return { start, end: zonedMidnight(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), timeZone) };
    }
    case 'monthly': {
      const start = zonedMidnight(p.year, p.month, 1, timeZone);
      const ny = p.month === 12 ? p.year + 1 : p.year;
      const nm = p.month === 12 ? 1 : p.month + 1;
      return { start, end: zonedMidnight(ny, nm, 1, timeZone) };
    }
    case 'annual':
      return { start: zonedMidnight(p.year, 1, 1, timeZone), end: zonedMidnight(p.year + 1, 1, 1, timeZone) };
  }
}

/** Fecha local YYYY-MM-DD en la zona. */
export function localDate(at: Date, timeZone = BOGOTA_TZ): string {
  const p = zonedParts(at, timeZone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}
