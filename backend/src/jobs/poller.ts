import type { Container } from '../container.js';

/**
 * Job de sondeo: depósitos Bre-B entrantes + estado de envíos pendientes en Coinsenda.
 * No es un webhook: Coinsenda avisa por su canal de tiempo real, así que se relee
 * la ventana de los 200 depósitos más recientes cada N segundos.
 * En producción: un solo worker (lock distribuido) o cola dedicada.
 */
export function startPoller(container: Container): () => void {
  const { deps, services, config } = container;
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const r = await services.deposits.poll();
      if (r.credited) deps.logger.info({ credited: r.credited }, 'deposits credited');
      const changed = await services.transfers.syncPending();
      if (changed) deps.logger.info({ changed }, 'pending transfers updated');
      const cardTxns = await services.cards.syncPurchases();
      if (cardTxns) deps.logger.info({ cardTxns }, 'card purchases synced');
      const matured = await services.savings.processMaturities();
      if (matured.completedCount) deps.logger.info({ completedCount: matured.completedCount }, 'savings blocks matured and credited');
      const overdue = await services.loans.syncOverdueLoans();
      if (overdue) deps.logger.info({ overdue }, 'overdue loans flagged');
    } catch (err) {
      deps.logger.error({ err: (err as Error).message }, 'poller tick failed');
    } finally {
      running = false;
    }
  };
  const handle = setInterval(() => void tick(), config.DEPOSIT_POLL_INTERVAL_MS);
  handle.unref();
  void tick();
  return () => clearInterval(handle);
}
