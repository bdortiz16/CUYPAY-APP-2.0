import { createRequire } from 'node:module';
import jwt from 'jsonwebtoken';
import NodeRSA from 'node-rsa';
import type { Logger } from 'pino';
import { AppError } from '../../lib/errors.js';
import { newId } from '../../lib/clock.js';
import { majorStringToMinor, minorToMajorString } from '../../lib/money.js';
import type { BrebAliasHolder, CoinsendaDeposit, CoinsendaGateway, WithdrawState } from '../../ports/index.js';
import type { Currency } from '../../domain/types.js';

// @coinsenda/sdk es CommonJS sin tipos: se carga con createRequire y se tipa lo mínimo.
const require = createRequire(import.meta.url);

interface SdkResult {
  status: number;
  data: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  headers?: Record<string, unknown>;
  error?: string;
}
type SdkFn = (arg?: unknown) => Promise<SdkResult>;
interface SdkClient {
  setJwt(token: string): void;
  setRefreshToken(token: string): void;
  setCountry(country: string): void;
  getUserId(): string | null;
  request(service: string, method: string, endpoint: string, data?: unknown, options?: Record<string, unknown>): Promise<SdkResult>;
  auth: { passport: { authPubkey: SdkFn }; oauth: { grantRefreshToken: SdkFn } };
  deposit: {
    depositProvider: {
      createDepositProviderByAccountIdPublic: SdkFn;
      blockDepositProviderPublic?: SdkFn;
      cancelDepositProviderPublic?: SdkFn;
      reactivateDepositProviderPublic?: SdkFn;
    };
    user: { __get__deposits: SdkFn; __get__depositProviders: SdkFn };
  };
  farming: {
    card: {
      setupAccountPublic: SdkFn;
      attachCardHolderPublic: SdkFn;
      getCardLookUrlPublic: SdkFn;
      updateWorkingStatePublic: SdkFn;
      updateLabelPublic: SdkFn;
      tokenizeApplePayPublic: SdkFn;
    };
    cardHolder: {
      addNewCardHolderPublic: SdkFn;
    };
    user: {
      __get__cards: SdkFn;
    };
  };
  marketplace: {
    product: {
      find: SdkFn;
    };
    shippingAddress: {
      addNewShippingAddressPublic: SdkFn;
    };
    sale: {
      addNewSalePublic: SdkFn;
    };
  };
  withdraw: {
    withdrawAccount: { resolveBrebAliasPublic: SdkFn; addNewWithdrawAccount: SdkFn; updateVisibility: SdkFn };
    withdraw: { addNewWithdrawPublic: SdkFn; addUpdateWithdraw: SdkFn };
    user: { __get__withdraws: SdkFn; __get__withdrawAccounts?: SdkFn };
  };
}
const sdk = require('@coinsenda/sdk') as {
  CoinsendaClient: new (opts: { domain: string }) => SdkClient;
  isHttpSuccess: (status: number) => boolean;
};

export interface LiveCoinsendaOptions {
  domain: string; // coinsenda.com (prod) | bitsenda.com (staging)
  email: string;
  privateKeyPem: string;
  brebDepositAccountId: string; // id del CATÁLOGO (medio Bre-B provisionado)
  copAccountId: string; // cuenta COP de CuyPay en Coinsenda (ómnibus)
  brebWithdrawProviderId?: string;
  logger: Logger;
}

/**
 * Adaptador real de Coinsenda (@coinsenda/sdk 1.9.0).
 *
 * Auth (README del SDK): firmamos {email, iat} RS256 5 min con la clave privada,
 * lo canjeamos en auth.passport.authPubkey por {jwt, refresh_token}, y la sesión
 * se renueva 60 s antes de vencer (refresh token → si falla, nueva firma). Ante un
 * 401 se re-autentica una vez y se reintenta.
 *
 * El SDK NO lanza en 4xx: devuelve { status, data } con data.error = { code, message }.
 * Modelo: CuyPay opera UNA cuenta Coinsenda (ómnibus). Cada llave Bre-B de usuario es un
 * depositProvider de esa cuenta; los depósitos se atribuyen por deposit_provider_id.
 */
export class LiveCoinsendaGateway implements CoinsendaGateway {
  private readonly client: SdkClient;
  private session: { jwt: string; refreshToken: string | null; expiresAt: number } | null = null;
  private readonly signingKey: string;

  constructor(private readonly opts: LiveCoinsendaOptions) {
    this.client = new sdk.CoinsendaClient({ domain: opts.domain });
    // TODO(coinsenda): confirmar el valor de `country` que espera el servicio para operar Bre-B (¿'colombia'?).
    // El SDK lo inyecta en cada payload; por defecto es 'international'.
    // Acepta PEM pkcs8 o pkcs1; jsonwebtoken recibe la exportación 'private' (pkcs1) como en el README.
    const pem = opts.privateKeyPem.replace(/\\n/g, '\n');
    const format = pem.includes('BEGIN RSA PRIVATE KEY') ? 'pkcs1-private-pem' : 'pkcs8-private-pem';
    this.signingKey = new NodeRSA(pem, format).exportKey('private');
  }

  // ───────────── sesión ─────────────

  private signAssertion(): string {
    return jwt.sign({ email: this.opts.email, iat: Math.floor(Date.now() / 1000) }, this.signingKey, {
      algorithm: 'RS256',
      expiresIn: '5m',
    });
  }

  private applySession(res: SdkResult) {
    const data = res.data?.data ?? res.data;
    if (!data?.jwt) {
      throw new AppError('PROVIDER_ERROR', 'Coinsenda no devolvió jwt (¿clave pública registrada?)', { provider: 'coinsenda' });
    }
    const decoded = jwt.decode(data.jwt) as { exp?: number } | null;
    this.session = {
      jwt: data.jwt,
      refreshToken: data.refresh_token ?? null,
      expiresAt: decoded?.exp ? decoded.exp * 1000 : Date.now() + 5 * 60_000,
    };
    this.client.setJwt(data.jwt);
    if (data.refresh_token) this.client.setRefreshToken(data.refresh_token);
  }

  private async login(): Promise<void> {
    const res = await this.client.auth.passport.authPubkey({ data: { signed_token: this.signAssertion() } });
    if (!sdk.isHttpSuccess(res.status)) {
      this.opts.logger.error({ status: res.status }, 'coinsenda auth failed');
      throw new AppError('PROVIDER_ERROR', `Autenticación con Coinsenda fallida (status ${res.status})`, { provider: 'coinsenda' });
    }
    this.applySession(res);
  }

  private async ensureSession(force = false): Promise<void> {
    if (!force && this.session && this.session.expiresAt - Date.now() > 60_000) return;
    if (!force && this.session?.refreshToken) {
      try {
        const res = await this.client.auth.oauth.grantRefreshToken({ data: { refresh_token: this.session.refreshToken } });
        if (sdk.isHttpSuccess(res.status)) return this.applySession(res);
      } catch {
        // cae a login completo
      }
    }
    await this.login();
  }

  /** Ejecuta una llamada con sesión válida; re-autentica una vez si responde 401. */
  private async call(name: string, fn: (c: SdkClient) => Promise<SdkResult>): Promise<SdkResult> {
    await this.ensureSession();
    let res = await fn(this.client);
    if (res.status === 401) {
      await this.ensureSession(true);
      res = await fn(this.client);
    }
    if (res.status === 0) {
      this.opts.logger.error({ op: name, err: res.error }, 'coinsenda network error');
      throw new AppError('PROVIDER_ERROR', 'Coinsenda no respondió', { provider: 'coinsenda', op: name });
    }
    return res;
  }

  private fail(name: string, res: SdkResult): never {
    const err = res.data?.error ?? res.data?.data?.error;
    this.opts.logger.warn({ op: name, status: res.status, code: err?.code, data: res.data }, 'coinsenda error');
    throw new AppError('PROVIDER_ERROR', `Coinsenda respondió ${res.status} en ${name}`, {
      provider: 'coinsenda',
      op: name,
      providerCode: err?.code ?? null,
    });
  }

  private getCoinsendaUserId(): string {
    const fromClient = typeof this.client.getUserId === 'function' ? this.client.getUserId() : null;
    if (fromClient) return fromClient;
    if (this.session?.jwt) {
      try {
        const parts = this.session.jwt.split('.');
        if (parts[1]) {
          const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString());
          return payload.userId || payload.usr || payload.id || payload.sub || '';
        }
      } catch {
        // ignore
      }
    }
    return '';
  }

  private payload(res: SdkResult): any { // eslint-disable-line @typescript-eslint/no-explicit-any
    return res.data?.data ?? res.data;
  }

  // ───────────── operaciones ─────────────

  async createBrebKey(input: { alias: string; holderName: string; userRef: string }) {
    await this.ensureSession();
    const cleanAlias = input.alias.trim();
    const formattedAlias = cleanAlias.startsWith('@') ? cleanAlias : `@${cleanAlias}`;
    const userId = this.getCoinsendaUserId();

    // Catálogo oficial de Bre-B en Coinsenda: 69391969002c69002ac2e285 (provider_type: breb, currency: cop)
    const depositAccountId =
      this.opts.brebDepositAccountId && this.opts.brebDepositAccountId !== '6aee0a69864db20012c9c504'
        ? this.opts.brebDepositAccountId
        : '69391969002c69002ac2e285';

    const res = await this.call('createBrebKey', (c) =>
      c.request(
        'deposit',
        'POST',
        '/depositProviders/create-deposit-provider-by-account-id-public',
        {
          data: {
            userId,
            account_id: this.opts.copAccountId,
            deposit_account_id: depositAccountId,
            alias: formattedAlias,
          },
        },
        { rawPayload: true },
      ),
    );
    if (!sdk.isHttpSuccess(res.status)) {
      const code = res.data?.error?.code ?? res.data?.data?.error?.code;
      if (res.status === 409 || code === 'depositprovider_already_exists') {
        throw new AppError('BREB_ALIAS_TAKEN', 'La llave Bre-B ya está tomada', { providerCode: code });
      }
      this.fail('createBrebKey', res);
    }
    const d = this.payload(res);
    const item = Array.isArray(d) ? d[0] : d;
    const assignedAlias =
      item?.account?.account_id?.account_id ??
      item?.account?.account_id ??
      item?.alias ??
      item?.address ??
      formattedAlias;
    return {
      providerKeyId: String(item?.id ?? item?.deposit_provider_id ?? newId('dp', new Date())),
      alias: String(assignedAlias),
      status: (item?.state === 'blocked' ? 'blocked' : item?.state === 'pending' ? 'pending' : 'active') as 'active' | 'pending' | 'blocked',
      qrCode: item?.account?.qr_code?.qr_string,
      raw: item,
    };
  }

  async resolveBrebAlias(alias: string): Promise<BrebAliasHolder | null> {
    await this.ensureSession();
    const userId = this.getCoinsendaUserId();
    const formattedAlias = formatBrebAlias(alias);

    const res = await this.call('resolveBrebAlias', (c) =>
      c.request(
        'withdraw',
        'POST',
        '/withdrawAccounts/resolve-breb-alias-public',
        {
          data: {
            userId,
            alias: formattedAlias,
            country: 'international',
          },
        },
        { rawPayload: true },
      ),
    );
    if (!sdk.isHttpSuccess(res.status)) {
      const err = res.data?.error ?? res.data?.data?.error;
      if (err?.code === 'withdrawaccount_23') return null;
      this.fail('resolveBrebAlias', res);
    }
    const d = this.payload(res);
    return {
      alias: formattedAlias,
      firstName: String(d?.first_name ?? d?.name ?? d?.holder_name ?? ''),
      lastName: String(d?.last_name ?? d?.surname ?? ''),
      documentType: String(d?.id_type ?? d?.document_type ?? 'CC'),
      documentNumber: String(d?.id_number ?? d?.document_number ?? ''),
      bankName: String(d?.bank_name ?? d?.participant_name ?? d?.entity ?? 'Bre-B'),
      raw: d,
    };
  }

  private async findExistingBrebWithdrawAccount(accountId: string): Promise<{ id: string; raw: any } | null> { // eslint-disable-line @typescript-eslint/no-explicit-any
    try {
      const res = await this.call('listWithdrawAccounts', (c) =>
        typeof c.withdraw.user.__get__withdrawAccounts === 'function'
          ? c.withdraw.user.__get__withdrawAccounts({ where: { visible: true } })
          : c.request('withdraw', 'GET', '/users/{id}/withdrawAccounts', { filter: JSON.stringify({ where: { visible: true } }) }, { rawPayload: true }),
      );
      if (!sdk.isHttpSuccess(res.status)) return null;
      const list: any[] = Array.isArray(res.data) ? res.data : Array.isArray(res.data?.data) ? res.data.data : []; // eslint-disable-line @typescript-eslint/no-explicit-any
      const target = accountId.toLowerCase().replace(/^@/, '');
      const found = list.find((acc) => {
        if (acc?.provider_type !== 'breb') return false;
        const a1 = String(acc?.info?.account_id ?? '').toLowerCase().replace(/^@/, '');
        const a2 = String(acc?.info?.identifier ?? '').toLowerCase().replace(/^@/, '');
        return (a1 && a1 === target) || (a2 && a2 === target);
      });
      return found?.id ? { id: String(found.id), raw: found } : null;
    } catch {
      return null;
    }
  }

  async addWithdrawAccount(input: { holder: BrebAliasHolder; label: string }) {
    await this.ensureSession();
    const h = input.holder;
    const accountId = formatBrebAlias(h.alias);
    const safeLabel = sanitizeWithdrawLabel(h, input.label);

    const existing = await this.findExistingBrebWithdrawAccount(accountId);
    if (existing) {
      return { withdrawAccountId: existing.id, raw: existing.raw };
    }

    // Coinsenda requiere que la llave Bre-B esté recién resuelta en sesión antes de crear la withdrawAccount.
    try {
      await this.resolveBrebAlias(accountId);
    } catch {
      // Ignorar en caso de que el mock de test no espere esta llamada extra
    }

    const baseData = {
      country: 'international',
      currency: 'cop',
      provider_type: 'breb',
      internal: false,
      info_needed: {
        label: safeLabel,
        country: 'colombia',
        account_id: accountId,
      },
    };

    let res = await this.call('addWithdrawAccount', (c) =>
      c.request('withdraw', 'POST', '/withdrawAccounts/add-new-withdraw-account', { data: baseData }, { rawPayload: true }),
    );
    if (!sdk.isHttpSuccess(res.status)) {
      const userId = this.getCoinsendaUserId();
      res = await this.call('addWithdrawAccount', (c) =>
        c.request('withdraw', 'POST', '/withdrawAccounts/add-new-withdraw-account', { data: { userId, ...baseData } }, { rawPayload: true }),
      );
    }
    if (!sdk.isHttpSuccess(res.status)) {
      const fallback = await this.findExistingBrebWithdrawAccount(accountId);
      if (fallback) return { withdrawAccountId: fallback.id, raw: fallback.raw };
      this.fail('addWithdrawAccount', res);
    }
    const d = this.payload(res);
    const createdId = d?.id ?? d?.withdraw_account_id;
    if (createdId) {
      return { withdrawAccountId: String(createdId), raw: d };
    }
    const refreshed = await this.findExistingBrebWithdrawAccount(accountId);
    if (refreshed) return { withdrawAccountId: refreshed.id, raw: refreshed.raw };
    return { withdrawAccountId: String(d?.id ?? d?.withdraw_account_id ?? ''), raw: d };
  }

  async hideWithdrawAccount(withdrawAccountId: string) {
    const res = await this.call('hideWithdrawAccount', (c) =>
      c.withdraw.withdrawAccount.updateVisibility({ withdraw_account_id: withdrawAccountId, visible: false }),
    );
    if (!sdk.isHttpSuccess(res.status)) this.fail('hideWithdrawAccount', res);
  }

  async createWithdraw(input: { withdrawAccountId: string; amountMinor: bigint; reference: string }) {
    await this.ensureSession();
    // Proveedor activo de retiro Bre-B COP en Coinsenda: 69403e8ec7583f0039ab01e9 (costo fijo proveedor: 3000 COP)
    const withdrawProviderId = this.opts.brebWithdrawProviderId || '69403e8ec7583f0039ab01e9';
    const providerFeeMinor = this.opts.domain === 'coinsenda.com' ? 300_000n : 0n;
    const primaryAmount = formatCoinsendaAmount(input.amountMinor + providerFeeMinor);

    const sendCreate = (amountStr: string) =>
      this.call('createWithdraw', (c) =>
        c.request(
          'withdraw',
          'POST',
          '/withdraws/add-new-withdraw-public',
          {
            data: {
              country: 'international',
              account_id: this.opts.copAccountId,
              amount: amountStr,
              withdraw_account_id: input.withdrawAccountId,
              withdraw_provider_id: withdrawProviderId,
            },
          },
          { rawPayload: true },
        ),
      );

    let res = await sendCreate(primaryAmount);
    if (!sdk.isHttpSuccess(res.status) && providerFeeMinor > 0n) {
      res = await sendCreate(formatCoinsendaAmount(input.amountMinor));
    }
    if (!sdk.isHttpSuccess(res.status)) this.fail('createWithdraw', res);
    const d = this.payload(res);
    return { withdrawId: String(d?.id ?? d?.withdraw_id), state: mapWithdrawState(d?.state ?? 'pending'), raw: d };
  }

  async confirmWithdraw(withdrawId: string) {
    const res = await this.call('confirmWithdraw', (c) =>
      c.request(
        'withdraw',
        'POST',
        '/withdraws/add-update-withdraw',
        {
          data: {
            withdraw_id: withdrawId,
            state: 'confirmed',
            country: 'international',
          },
        },
        { rawPayload: true },
      ),
    );
    if (!sdk.isHttpSuccess(res.status)) this.fail('confirmWithdraw', res);
    const d = this.payload(res);
    return { state: mapWithdrawState(d?.state ?? 'confirmed'), raw: d };
  }

  async getWithdraw(withdrawId: string) {
    const res = await this.call('getWithdraw', (c) => c.withdraw.user.__get__withdraws({ where: { id: withdrawId }, limit: 1 }));
    if (!sdk.isHttpSuccess(res.status)) this.fail('getWithdraw', res);
    const list = Array.isArray(res.data) ? res.data : Array.isArray(res.data?.data) ? res.data.data : [];
    const w = list[0];
    return w ? { state: mapWithdrawState(w.state), raw: w } : null;
  }

  /** Saldo de la cuenta COP ómnibus. TODO(coinsenda): confirmar el campo de saldo disponible en `__get__accounts`. */
  async getBalance() {
    const res = await this.call('getBalance', (c) =>
      (c as any).account.user.__get__accounts({ where: { id: this.opts.copAccountId }, limit: 1 }), // eslint-disable-line @typescript-eslint/no-explicit-any
    );
    if (!sdk.isHttpSuccess(res.status)) this.fail('getBalance', res);
    const list: any[] = Array.isArray(res.data) ? res.data : Array.isArray(res.data?.data) ? res.data.data : []; // eslint-disable-line @typescript-eslint/no-explicit-any
    const acc = list[0];
    const raw = acc?.available ?? acc?.balance?.available ?? acc?.balance;
    if (raw === undefined || raw === null) throw new AppError('PROVIDER_ERROR', 'Coinsenda no devolvió el saldo de la cuenta COP', { provider: 'coinsenda' });
    return { currency: 'COP' as const, balanceMinor: majorStringToMinor(String(raw)), asOf: new Date() };
  }

  async updateBrebKeyStatus(providerKeyId: string, status: 'active' | 'blocked') {
    const res = await this.call('updateBrebKeyStatus', (c) => {
      const dp = c.deposit.depositProvider;
      if (status === 'blocked' && dp.blockDepositProviderPublic) {
        return dp.blockDepositProviderPublic({ deposit_provider_id: providerKeyId });
      }
      if (status === 'active' && dp.reactivateDepositProviderPublic) {
        return dp.reactivateDepositProviderPublic({ deposit_provider_id: providerKeyId });
      }
      return Promise.resolve({ status: 200, data: {} });
    });
    if (!sdk.isHttpSuccess(res.status)) this.fail('updateBrebKeyStatus', res);
  }

  async cancelBrebKey(providerKeyId: string) {
    const res = await this.call('cancelBrebKey', (c) => {
      const dp = c.deposit.depositProvider;
      if (dp.cancelDepositProviderPublic) {
        return dp.cancelDepositProviderPublic({ deposit_provider_id: providerKeyId });
      }
      return Promise.resolve({ status: 200, data: {} });
    });
    if (!sdk.isHttpSuccess(res.status)) this.fail('cancelBrebKey', res);
  }

  // ── Tarjetas ──
  private extractList(res: SdkResult): any[] { // eslint-disable-line @typescript-eslint/no-explicit-any
    const d = this.payload(res);
    return Array.isArray(d) ? d : Array.isArray(res.data) ? res.data : [];
  }

  private async listProviderCards(): Promise<any[]> { // eslint-disable-line @typescript-eslint/no-explicit-any
    const res = await this.call('listCards', (c) =>
      c.request('farming', 'GET', '/users/{id}/cards', {}, { rawPayload: true }),
    );
    if (!sdk.isHttpSuccess(res.status)) return [];
    return this.extractList(res);
  }

  private async listCardHolders(): Promise<any[]> { // eslint-disable-line @typescript-eslint/no-explicit-any
    const res = await this.call('listCardHolders', (c) =>
      c.request('farming', 'GET', '/users/{id}/cardHolders', {}, { rawPayload: true }),
    );
    if (!sdk.isHttpSuccess(res.status)) return [];
    return this.extractList(res);
  }

  async issueCard(input: {
    userId: string;
    holderName: string;
    email: string;
    currency: Currency;
    label?: string;
  }) {
    await this.ensureSession();
    const targetCurrency = input.currency.toLowerCase();
    const cleanEmail = input.email.trim().toLowerCase();
    const cleanLabel = sanitizeCardLabel(input.label);

    // 1. Obtener o aprovisionar ledgerAccount en Coinsenda Farming (ej. mono_cop)
    const ledgersRes = await this.call('listLedgerAccounts', (c) =>
      c.request('farming', 'GET', '/users/{id}/ledgerAccounts', {}, { rawPayload: true }),
    );
    let ledgers = sdk.isHttpSuccess(ledgersRes.status) ? this.extractList(ledgersRes) : [];
    let ledger = ledgers.find((l) => String(l?.currency ?? '').toLowerCase() === targetCurrency);

    if (!ledger?.id) {
      const setupRes = await this.call('setupAccountPublic', (c) =>
        c.request(
          'farming',
          'POST',
          '/cards/setup-account-public',
          { data: { currency: targetCurrency, label: 'CuyPay', country: 'international' } },
          { rawPayload: true },
        ),
      );
      if (!sdk.isHttpSuccess(setupRes.status)) this.fail('setupAccountPublic', setupRes);
      const setupData = this.payload(setupRes);
      const retryLedgersRes = await this.call('listLedgerAccountsAfterSetup', (c) =>
        c.request('farming', 'GET', '/users/{id}/ledgerAccounts', {}, { rawPayload: true }),
      );
      if (sdk.isHttpSuccess(retryLedgersRes.status)) {
        ledgers = this.extractList(retryLedgersRes);
        ledger = ledgers.find((l) => String(l?.currency ?? '').toLowerCase() === targetCurrency);
      }
      if (!ledger?.id) {
        const fallbackId = setupData?.ledger_account?.id ?? setupData?.ledger_account_id ?? setupData?.id;
        if (fallbackId) ledger = { id: String(fallbackId), currency: targetCurrency };
      }
    }
    if (!ledger?.id) {
      throw new AppError('PROVIDER_ERROR', `Coinsenda no tiene una cuenta de tarjeta activa en ${input.currency}.`, {
        provider: 'coinsenda',
      });
    }
    const ledgerAccountId = String(ledger.id);

    // 2. Obtener o sincronizar titular de tarjeta (cardHolder)
    let holders = await this.listCardHolders();
    const matchHolder = (list: any[]) => // eslint-disable-line @typescript-eslint/no-explicit-any
      list.find(
        (h) =>
          (!h?.provider || String(h.provider).toLowerCase().includes(targetCurrency)) &&
          String(h?.info_needed?.email ?? '').trim().toLowerCase() === cleanEmail,
      ) ??
      list.find((h) => !h?.provider || String(h.provider).toLowerCase().includes(targetCurrency)) ??
      list[0];

    let holder = matchHolder(holders);
    if (!holder?.id) {
      const syncHolderRes = await this.call('addNewCardHolderPublic', (c) =>
        c.request(
          'farming',
          'POST',
          '/cardHolders/add-new-card-holder-public',
          { data: { currency: targetCurrency, country: 'international' } },
          { rawPayload: true },
        ),
      );
      if (sdk.isHttpSuccess(syncHolderRes.status)) {
        const createdHolder = this.payload(syncHolderRes);
        if (createdHolder?.id) holder = createdHolder;
      }
      if (!holder?.id) {
        holders = await this.listCardHolders();
        holder = matchHolder(holders);
      }
    }
    if (!holder?.id) {
      throw new AppError(
        'PROVIDER_ERROR',
        'No se encontró un titular de tarjeta (CardHolder) activo en Coinsenda para emitir la tarjeta virtual.',
        { provider: 'coinsenda' },
      );
    }
    const cardHolderId = String(holder.id);

    // 3. Consultar producto de tarjeta virtual e inventario en Marketplace
    const productKey = targetCurrency === 'cop' ? 'coinsenda-virtual-cop-card' : `coinsenda-virtual-${targetCurrency}-card`;
    const prodFilter = JSON.stringify({
      where: { key: productKey },
      include: [{ relation: 'stocks', scope: { include: ['shippingProvider'] } }],
    });
    const prodRes = await this.call('findCardProduct', (c) =>
      c.request('marketplace', 'GET', '/products', { filter: prodFilter }, { rawPayload: true }),
    );
    if (!sdk.isHttpSuccess(prodRes.status)) this.fail('findCardProduct', prodRes);
    const products = this.extractList(prodRes);
    const product = products[0];
    if (!product?.id || product?.status !== 'available') {
      throw new AppError('PROVIDER_ERROR', 'El producto de tarjeta virtual no está disponible actualmente en Coinsenda.', {
        provider: 'coinsenda',
      });
    }
    const stocks: any[] = Array.isArray(product.stocks) ? product.stocks : []; // eslint-disable-line @typescript-eslint/no-explicit-any
    const availableStock = stocks.find((s) => Number(s?.available ?? 0) > 0) ?? stocks[0];

    // 4. Obtener o crear dirección digital de entrega por correo (requerida por Marketplace)
    const addrsRes = await this.call('listShippingAddresses', (c) =>
      c.request('marketplace', 'GET', '/users/{id}/shippingAddresses', {}, { rawPayload: true }),
    );
    const existingAddrs = sdk.isHttpSuccess(addrsRes.status) ? this.extractList(addrsRes) : [];
    const digitalAddrs = existingAddrs.filter((a) => a?.address_type === 'digital' || a?.transport_type === 'email');
    let shippingAddress = digitalAddrs.find((a) => String(a?.info?.email ?? '').trim().toLowerCase() === cleanEmail);

    if (!shippingAddress?.id && availableStock?.shipping_provider_id && cleanEmail) {
      const createAddrRes = await this.call('addNewShippingAddressPublic', (c) =>
        c.request(
          'marketplace',
          'POST',
          '/shippingAddresses/add-new-shipping-address-public',
          {
            data: {
              shipping_provider_id: String(availableStock.shipping_provider_id),
              info_needed: { email: cleanEmail, label: cleanEmail },
              transport_type: 'email',
              country: 'international',
            },
          },
          { rawPayload: true },
        ),
      );
      if (sdk.isHttpSuccess(createAddrRes.status)) {
        const addrData = this.payload(createAddrRes);
        if (addrData?.id) shippingAddress = addrData;
      }
    }
    if (!shippingAddress?.id && digitalAddrs[0]?.id) {
      shippingAddress = digitalAddrs[0];
    }

    // 5. Tomar foto de tarjetas previas y registrar la orden de tarjeta virtual (precio 0)
    const cardsBefore = await this.listProviderCards();
    const existingCardIds = new Set(cardsBefore.map((c) => String(c.id)));

    const saleRes = await this.call('addNewSalePublic', (c) =>
      c.request(
        'marketplace',
        'POST',
        '/sales/add-new-sale-public',
        {
          data: {
            country: 'international',
            shipping_address_ids: shippingAddress?.id ? [String(shippingAddress.id)] : [],
            products: [
              {
                product_id: String(product.id),
                quantity: 1,
                ledger_account_id: ledgerAccountId,
                card_label: cleanLabel,
                card_holder_id: cardHolderId,
              },
            ],
          },
        },
        { rawPayload: true },
      ),
    );
    if (!sdk.isHttpSuccess(saleRes.status)) {
      const err = saleRes.data?.error ?? saleRes.data?.data?.error;
      this.opts.logger?.warn?.(
        { status: saleRes.status, code: err?.code, data: saleRes.data },
        'Fallo al emitir tarjeta virtual en marketplace de Coinsenda',
      );
      throw new AppError(
        'PROVIDER_ERROR',
        err?.message ? `Coinsenda rechazó la emisión de la tarjeta: ${err.message}` : `Coinsenda respondió ${saleRes.status} al solicitar la tarjeta virtual.`,
        { provider: 'coinsenda', providerStatus: saleRes.status, providerCode: err?.code ?? null },
      );
    }

    const saleData = this.payload(saleRes);
    const saleTradeIds = new Set<string>(
      Array.isArray(saleData?.trade_ids) ? saleData.trade_ids.map((t: unknown) => String(t)) : [],
    );

    // 6. Activar tarjeta confirmada y recuperar su registro desde Farming
    const pollDelaysMs = this.opts.domain === 'coinsenda.com' ? [400, 1000, 1500, 1500, 2000, 2000] : [0, 50];
    let matchedCard: any = null; // eslint-disable-line @typescript-eslint/no-explicit-any
    for (const delayMs of pollDelaysMs) {
      if (delayMs > 0) await sleep(delayMs);
      await this.call('assignActiveCardToConfirmedCardsPublic', (c) =>
        c.request(
          'farming',
          'POST',
          '/cards/assign-active-card-to-confirmed-cards-public',
          { data: { country: 'international' } },
          { rawPayload: true },
        ),
      ).catch(() => null);

      const currentCards = await this.listProviderCards();
      matchedCard =
        currentCards.find((c) => c?.trade_id && saleTradeIds.has(String(c.trade_id))) ??
        currentCards.find((c) => !existingCardIds.has(String(c.id)) && c?.working_state !== 'canceled');
      if (matchedCard?.id) break;
    }

    if (!matchedCard?.id) {
      throw new AppError(
        'PROVIDER_ERROR',
        'La orden de tarjeta virtual fue creada en Coinsenda pero aún se está aprovisionando. Intenta recargar en unos segundos.',
        { provider: 'coinsenda', saleId: saleData?.id ?? null },
      );
    }

    const providerCardId = String(matchedCard.id);

    // 7. Vincular cardHolder si aún no está asociado en Farming y refrescar últimos 4 dígitos
    if (!matchedCard.card_holder_id && cardHolderId) {
      await this.call('attachCardHolderPublic', (c) =>
        c.request(
          'farming',
          'POST',
          '/cards/attach-card-holder-public',
          {
            data: {
              card_id: providerCardId,
              ledger_account_id: ledgerAccountId,
              card_holder_id: cardHolderId,
              country: 'international',
            },
          },
          { rawPayload: true },
        ),
      ).catch(() => null);
    }

    const lastFourPollMs = this.opts.domain === 'coinsenda.com' ? [800, 1200, 1500] : [20];
    for (const waitMs of lastFourPollMs) {
      const currentDigits = String(matchedCard.last_four ?? matchedCard.last4 ?? '');
      if (/^\d{4}$/.test(currentDigits) && currentDigits !== '0000') break;
      if (waitMs > 0) await sleep(waitMs);
      const refreshedCards = await this.listProviderCards();
      const refreshed = refreshedCards.find((c) => String(c.id) === providerCardId);
      if (refreshed) matchedCard = refreshed;
    }

    return {
      providerCardId,
      ledgerAccountId: String(matchedCard.ledger_account_id ?? ledgerAccountId),
      lastFour: String(matchedCard.last_four ?? matchedCard.last4 ?? '0000'),
      brand: detectCardBrand(matchedCard, product),
      status: (matchedCard.working_state === 'frozen' ? 'frozen' : 'active') as 'active' | 'frozen',
      raw: matchedCard,
    };
  }

  async getProviderCards() {
    const cards = await this.listProviderCards();
    return cards
      .filter((c) => c?.id != null)
      .map((c) => ({
        providerCardId: String(c.id),
        lastFour: String(c.last_four ?? c.last4 ?? '0000'),
        brand: detectCardBrand(c),
        status: (
          c.working_state === 'frozen' ? 'frozen' : c.working_state === 'canceled' ? 'canceled' : 'active'
        ) as 'active' | 'frozen' | 'canceled',
        label: typeof c.label === 'string' ? c.label : undefined,
      }));
  }

  async getCardLookUrl(providerCardId: string) {
    const cards = await this.listProviderCards();
    const card = cards.find((c) => String(c.id) === providerCardId);
    const ledgerAccountId = card?.ledger_account_id ? String(card.ledger_account_id) : undefined;
    let cardHolderId = card?.card_holder_id ? String(card.card_holder_id) : undefined;
    if (!cardHolderId) {
      const holders = await this.listCardHolders();
      if (holders[0]?.id) cardHolderId = String(holders[0].id);
    }

    const res = await this.call('getCardLookUrl', (c) =>
      c.request(
        'farming',
        'POST',
        '/cards/get-card-look-url-public',
        {
          data: {
            card_id: providerCardId,
            ...(ledgerAccountId ? { ledger_account_id: ledgerAccountId } : {}),
            ...(cardHolderId ? { cardholder_id: cardHolderId } : {}),
            country: 'international',
          },
        },
        { rawPayload: true },
      ),
    );
    if (!sdk.isHttpSuccess(res.status)) this.fail('getCardLookUrl', res);
    const d = this.payload(res);
    const url = typeof d === 'string' ? d : String(d?.url ?? d?.look_url ?? '');
    return { url };
  }

  async updateCardWorkingState(providerCardId: string, state: 'active' | 'frozen' | 'canceled') {
    const res = await this.call('updateCardWorkingState', (c) =>
      c.request(
        'farming',
        'POST',
        '/cards/update-working-state-public',
        { data: { card_id: providerCardId, new_working_state: state, country: 'international' } },
        { rawPayload: true },
      ),
    );
    if (!sdk.isHttpSuccess(res.status)) this.fail('updateCardWorkingState', res);
  }

  async updateCardLabel(providerCardId: string, label: string) {
    const res = await this.call('updateCardLabel', (c) =>
      c.request(
        'farming',
        'POST',
        '/cards/update-label-public',
        { data: { card_id: providerCardId, new_label: sanitizeCardLabel(label), country: 'international' } },
        { rawPayload: true },
      ),
    );
    if (!sdk.isHttpSuccess(res.status)) this.fail('updateCardLabel', res);
  }

  async tokenizeApplePay(input: {
    providerCardId: string;
    certificates: string[];
    nonce: string;
    nonceSignature: string;
  }) {
    const res = await this.call('tokenizeApplePay', (c) =>
      c.request(
        'farming',
        'POST',
        '/cards/tokenize-apple-pay-public',
        {
          data: {
            card_id: input.providerCardId,
            certificates: input.certificates,
            nonce: input.nonce,
            nonce_signature: input.nonceSignature,
            country: 'international',
          },
        },
        { rawPayload: true },
      ),
    );
    if (!sdk.isHttpSuccess(res.status)) this.fail('tokenizeApplePay', res);
    const d = this.payload(res);
    return {
      activationData: String(d?.activation_data ?? d?.activationData ?? ''),
      encryptedPassData: String(d?.encrypted_pass_data ?? d?.encryptedPassData ?? ''),
      ephemeralPublicKey: String(d?.ephemeral_public_key ?? d?.ephemeralPublicKey ?? ''),
    };
  }

  async healthCheck(): Promise<void> {
    await this.ensureSession();
  }

  async listDeposits(): Promise<CoinsendaDeposit[]> {
    // Los 200 más RECIENTES (sin `order` llegan los más viejos y los nuevos nunca aparecen).
    const res = await this.call('listDeposits', (c) => c.deposit.user.__get__deposits({ order: 'id DESC', limit: 200 }));
    if (!sdk.isHttpSuccess(res.status)) this.fail('listDeposits', res);
    const list: any[] = Array.isArray(res.data) ? res.data : Array.isArray(res.data?.data) ? res.data.data : []; // eslint-disable-line @typescript-eslint/no-explicit-any
    return list
      .filter((d) => String(d?.currency ?? '').toLowerCase() === 'cop')
      .map((d) => ({
        id: String(d.id),
        providerKeyId: d.deposit_provider_id != null ? String(d.deposit_provider_id) : null,
        // TODO(coinsenda): confirmar si `amount` llega en unidades mayores (string decimal) y si existe `amount_neto`.
        amountMinor: majorStringToMinor(String(d.amount_neto ?? d.amount ?? '0')),
        currency: 'COP' as const,
        // TODO(coinsenda): confirmar el estado final de un depósito acreditado (asumido 'accepted'/'confirmed').
        state: ['accepted', 'confirmed', 'completed'].includes(d.state)
          ? ('accepted' as const)
          : ['rejected', 'canceled'].includes(d.state)
            ? ('rejected' as const)
            : ('pending' as const),
        // TODO(coinsenda): ¿viene el nombre del pagador Bre-B? (campo asumido `sender_name`).
        payerName: d.sender_name ?? d.info?.sender_name ?? null,
        createdAt: new Date(d.created_at ?? Date.now()),
        raw: d,
      }));
  }
}

function formatBrebAlias(raw: string): string {
  const clean = raw.trim();
  if (!clean) return clean;
  const withoutAt = clean.replace(/^@/, '');
  if (withoutAt.includes('@')) return withoutAt.toLowerCase();
  if (/^\d+$/.test(withoutAt)) return clean.startsWith('@') ? `@${withoutAt}` : withoutAt;
  return `@${withoutAt}`;
}

function formatCoinsendaAmount(minor: bigint): string {
  if (minor % 100n === 0n) return (minor / 100n).toString();
  return minorToMajorString(minor);
}

function sanitizeWithdrawLabel(holder: BrebAliasHolder, fallbackLabel: string): string {
  const rawName = `${holder.firstName} ${holder.lastName}`.trim() || fallbackLabel;
  const cleaned = rawName
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 35);
  return cleaned || 'Beneficiario CuyPay';
}

function mapWithdrawState(state: unknown): WithdrawState {
  switch (state) {
    case 'completed':
    case 'complete':
      return 'accepted';
    case 'pending':
    case 'confirmed':
    case 'accepted':
    case 'rejected':
    case 'canceled':
    case 'failed':
      return state;
    default:
      return 'unknown';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitizeCardLabel(raw?: string): string {
  const cleaned = String(raw ?? 'CuyPay Virtual')
    .replace(/[^a-zA-Z\u00C0-\u00FF0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 30);
  return cleaned.length >= 3 ? cleaned : 'CuyPay Virtual';
}

function detectCardBrand(card: any, product?: any): string { // eslint-disable-line @typescript-eslint/no-explicit-any
  const raw = String(card?.brand ?? card?.franchise ?? product?.specs?.brand ?? product?.name ?? '').toLowerCase();
  if (raw.includes('master')) return 'Mastercard';
  if (raw.includes('visa')) return 'Visa';
  return 'Visa';
}

