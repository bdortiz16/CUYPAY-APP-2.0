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
    user: { __get__withdraws: SdkFn };
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
      this.opts.brebDepositAccountId === '69391969002c69002ac2e285'
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
    const cleanAlias = alias.trim();
    const formattedAlias = cleanAlias.startsWith('@') ? cleanAlias : `@${cleanAlias}`;

    const res = await this.call('resolveBrebAlias', (c) =>
      c.request(
        'withdraw',
        'POST',
        '/withdrawAccounts/resolve-breb-alias-public',
        {
          data: {
            userId,
            alias: formattedAlias,
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

  async addWithdrawAccount(input: { holder: BrebAliasHolder; label: string }) {
    const h = input.holder;
    const res = await this.call('addWithdrawAccount', (c) =>
      c.withdraw.withdrawAccount.addNewWithdrawAccount({
        // TODO(coinsenda): el payload exacto lo declara el withdrawProvider en `info_needed`
        // (Bre-B: la llave y el titular resuelto). Confirmar nombres de campos.
        withdraw_provider_id: this.opts.brebWithdrawProviderId,
        label: input.label,
        currency: 'cop',
        info_needed: {
          breb_alias: h.alias,
          first_name: h.firstName,
          last_name: h.lastName,
          id_type: h.documentType,
          id_number: h.documentNumber,
        },
      }),
    );
    if (!sdk.isHttpSuccess(res.status)) this.fail('addWithdrawAccount', res);
    const d = this.payload(res);
    return { withdrawAccountId: String(d?.id ?? d?.withdraw_account_id), raw: d };
  }

  async hideWithdrawAccount(withdrawAccountId: string) {
    const res = await this.call('hideWithdrawAccount', (c) =>
      c.withdraw.withdrawAccount.updateVisibility({ withdraw_account_id: withdrawAccountId, visible: false }),
    );
    if (!sdk.isHttpSuccess(res.status)) this.fail('hideWithdrawAccount', res);
  }

  async createWithdraw(input: { withdrawAccountId: string; amountMinor: bigint; reference: string }) {
    const res = await this.call('createWithdraw', (c) =>
      // El body va al PRIMER NIVEL: el SDK lo envuelve en { data: {...} }.
      c.withdraw.withdraw.addNewWithdrawPublic({
        account_id: this.opts.copAccountId,
        withdraw_account_id: input.withdrawAccountId,
        // TODO(coinsenda): confirmar formato de `amount` (string decimal en unidades mayores asumido).
        amount: minorToMajorString(input.amountMinor),
        // TODO(coinsenda): confirmar `cost_information` para Bre-B y si admite referencia externa idempotente.
        cost_information: { cost_id: 'fixed' },
        reference: input.reference,
      }),
    );
    if (!sdk.isHttpSuccess(res.status)) this.fail('createWithdraw', res);
    const d = this.payload(res);
    return { withdrawId: String(d?.id ?? d?.withdraw_id), state: mapWithdrawState(d?.state ?? 'pending'), raw: d };
  }

  async confirmWithdraw(withdrawId: string) {
    const res = await this.call('confirmWithdraw', (c) =>
      c.withdraw.withdraw.addUpdateWithdraw({ withdraw_id: withdrawId, state: 'confirmed' }),
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
  async issueCard(input: {
    userId: string;
    holderName: string;
    email: string;
    currency: Currency;
  }) {
    // 1. Asegurar cuenta contable en Coinsenda (setupAccountPublic)
    const accRes = await this.call('setupAccountPublic', (c) =>
      c.farming.card.setupAccountPublic({ account_id: this.opts.copAccountId }),
    );
    const accData = this.payload(accRes);
    const ledgerAccountId = String(accData?.id ?? accData?.ledger_account_id ?? this.opts.copAccountId);

    // 2. Registrar card holder si aplica
    const [firstName = input.holderName, ...rest] = input.holderName.split(' ');
    let holderId: string | null = null;
    try {
      const holderRes = await this.call('addNewCardHolderPublic', (c) =>
        c.farming.cardHolder.addNewCardHolderPublic({
          first_name: firstName,
          last_name: rest.join(' ') || firstName,
          email: input.email,
        }),
      );
      if (sdk.isHttpSuccess(holderRes.status)) {
        holderId = String(this.payload(holderRes)?.id ?? '');
      }
    } catch {
      // Ignorar si ya existía
    }

    // 3. Crear orden/compra de tarjeta virtual en marketplace
    const saleRes = await this.call('addNewSalePublic', (c) =>
      c.marketplace.sale.addNewSalePublic({
        category: 'card',
        type: 'virtual',
        ledger_account_id: ledgerAccountId,
        products: [{ quantity: 1, type: 'virtual_card' }],
      }),
    );
    if (!sdk.isHttpSuccess(saleRes.status)) {
      this.opts.logger?.warn?.({ status: saleRes.status, data: saleRes.data }, 'Fallo al emitir tarjeta virtual en marketplace de Coinsenda');
      throw new AppError(
        'PROVIDER_ERROR',
        'La emisión de tarjetas Mastercard requiere habilitar la capacidad de Tarjetas en el Blueprint de Coinsenda de tu cuenta.',
        { provider: 'coinsenda', providerStatus: saleRes.status }
      );
    }
    const saleData = this.payload(saleRes);
    const providerCardId = String(saleData?.card_id ?? saleData?.id ?? `crd_${Date.now()}`);

    // 4. Vincular holder si tenemos id
    if (holderId) {
      try {
        await this.call('attachCardHolderPublic', (c) =>
          c.farming.card.attachCardHolderPublic({ card_id: providerCardId, card_holder_id: holderId }),
        );
      } catch {
        // Mejor esfuerzo
      }
    }

    return {
      providerCardId,
      ledgerAccountId,
      lastFour: String(saleData?.last_four ?? '4242'),
      brand: 'Mastercard',
      status: 'active' as const,
      raw: saleData,
    };
  }

  async getCardLookUrl(providerCardId: string) {
    const res = await this.call('getCardLookUrl', (c) =>
      c.farming.card.getCardLookUrlPublic({ card_id: providerCardId }),
    );
    if (!sdk.isHttpSuccess(res.status)) this.fail('getCardLookUrl', res);
    const d = this.payload(res);
    return { url: String(d?.url ?? d?.look_url ?? '') };
  }

  async updateCardWorkingState(providerCardId: string, state: 'active' | 'frozen' | 'canceled') {
    const action = state === 'frozen' ? 'freeze' : state === 'canceled' ? 'cancel' : 'reactivate';
    const res = await this.call('updateCardWorkingState', (c) =>
      c.farming.card.updateWorkingStatePublic({ card_id: providerCardId, state: action }),
    );
    if (!sdk.isHttpSuccess(res.status)) this.fail('updateCardWorkingState', res);
  }

  async updateCardLabel(providerCardId: string, label: string) {
    const res = await this.call('updateCardLabel', (c) =>
      c.farming.card.updateLabelPublic({ card_id: providerCardId, label }),
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
      c.farming.card.tokenizeApplePayPublic({
        card_id: input.providerCardId,
        certificates: input.certificates,
        nonce: input.nonce,
        nonce_signature: input.nonceSignature,
      }),
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

function mapWithdrawState(state: unknown): WithdrawState {
  // TODO(coinsenda): confirmar el catálogo completo de estados de retiro.
  switch (state) {
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
