import { localDate, periodRange } from '../../lib/time.js';
import type { ServiceDeps } from '../deps.js';
import type { ProviderHealthService } from './providers.js';
import type { TreasuryService } from './treasury.js';

const n = (v: bigint) => Number(v);

/** KPIs del dashboard + serie de 30 días (fechas calendario de Bogotá). */
export class DashboardService {
  constructor(
    private readonly d: ServiceDeps,
    private readonly treasury: TreasuryService,
    private readonly providers: ProviderHealthService,
  ) {}

  async get() {
    const now = this.d.clock.now();
    const today = periodRange(now, 'daily');
    const isToday = (d: Date) => d >= today.start && d < today.end;
    const users = await this.d.repos.users.listAll();
    let frozen = 0;
    for (const u of users) if ((await this.d.repos.customerControls.get(u.id))?.status === 'frozen') frozen++;
    const txns = await this.d.repos.transactions.listAll();

    const t = {
      deposits: { count: 0, volume: 0n },
      transfers: { count: 0, volume: 0n },
      conversions: { count: 0, from: 0n, to: 0n },
    };
    // Serie: últimos 30 días incluyendo hoy.
    const days: string[] = [];
    for (let i = 29; i >= 0; i--) days.push(localDate(new Date(now.getTime() - i * 86_400_000)));
    const series = new Map(days.map((d) => [d, { date: d, depositsMinor: 0n, transfersMinor: 0n, conversionsMinor: 0n, newCustomers: 0, revenueMinor: 0n }]));
    let failedToday = 0;
    for (const x of txns) {
      if (x.status === 'failed' && isToday(x.updatedAt)) failedToday++;
      if (x.status !== 'completed' && x.status !== 'pending') continue;
      const day = series.get(localDate(x.createdAt));
      const td = isToday(x.createdAt);
      if (x.type === 'deposit') {
        if (td) {
          t.deposits.count++;
          t.deposits.volume += x.amountMinor;
        }
        if (day) day.depositsMinor += x.amountMinor;
      } else if (x.type === 'transfer') {
        if (td) {
          t.transfers.count++;
          t.transfers.volume += x.amountMinor;
        }
        if (day) {
          day.transfersMinor += x.amountMinor;
          if (x.status === 'completed') day.revenueMinor += x.feeMinor;
        }
      } else {
        if (td) {
          t.conversions.count++;
          t.conversions.from += x.amountMinor;
          t.conversions.to += x.conversion?.toAmountMinor ?? 0n;
        }
        if (day) {
          day.conversionsMinor += x.amountMinor;
          day.revenueMinor += x.feeMinor;
        }
      }
    }
    for (const u of users) {
      const day = series.get(localDate(u.createdAt));
      if (day) day.newCustomers++;
    }
    const treasury = await this.treasury.snapshot();
    const bens = await this.d.repos.beneficiaries.listAll();
    const alerts = await this.d.repos.alerts.list();
    return {
      generatedAt: now.toISOString(),
      customers: {
        total: users.length,
        newToday: users.filter((u) => isToday(u.createdAt)).length,
        kycApproved: users.filter((u) => u.kycStatus === 'approved').length,
        kycPending: users.filter((u) => u.kycStatus === 'pending').length,
        frozen,
      },
      today: {
        deposits: { count: t.deposits.count, volumeMinor: n(t.deposits.volume), currency: 'COP' as const },
        transfers: { count: t.transfers.count, volumeMinor: n(t.transfers.volume), currency: 'COP' as const },
        conversions: {
          count: t.conversions.count,
          fromVolumeMinor: n(t.conversions.from),
          toVolumeMinor: n(t.conversions.to),
          fromCurrency: 'COP' as const,
          toCurrency: 'BRL' as const,
        },
        revenueMinor: treasury.revenue.todayMinor,
        revenueCurrency: 'COP' as const,
      },
      series: [...series.values()].map((s) => ({
        date: s.date,
        depositsMinor: n(s.depositsMinor),
        transfersMinor: n(s.transfersMinor),
        conversionsMinor: n(s.conversionsMinor),
        revenueMinor: n(s.revenueMinor),
        newCustomers: s.newCustomers,
      })),
      queues: {
        amlReview: bens.filter((b) => b.status === 'pending_review' && !b.deletedAt).length,
        complianceAlerts: alerts.filter((a) => a.status === 'open').length,
        failedTransactions: failedToday,
      },
      providers: await this.providers.list(),
      treasury,
    };
  }
}
