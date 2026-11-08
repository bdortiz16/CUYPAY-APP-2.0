import { AppError } from '../../lib/errors.js';

/** Paginación por cursor opaco (fecha + id) sobre listas ya ordenadas DESC. */
export function paginate<T>(rows: T[], key: (r: T) => { at: Date; id: string }, limit: number, cursor?: string) {
  let start = 0;
  if (cursor) {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    const [ts, id] = raw.split('|');
    const at = new Date(ts ?? '');
    if (!id || Number.isNaN(at.getTime())) throw new AppError('VALIDATION_ERROR', 'Cursor inválido', { field: 'cursor' });
    start = rows.findIndex((r) => {
      const k = key(r);
      const dt = k.at.getTime() - at.getTime();
      return dt < 0 || (dt === 0 && k.id < id);
    });
    if (start < 0) start = rows.length;
  }
  const page = rows.slice(start, start + limit);
  const last = page[page.length - 1];
  const nextCursor =
    start + limit < rows.length && last ? Buffer.from(`${key(last).at.toISOString()}|${key(last).id}`).toString('base64url') : null;
  return { page, nextCursor };
}
