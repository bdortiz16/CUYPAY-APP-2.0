import { generateKeyPairSync } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { LiveCoinsendaGateway } from '../src/adapters/coinsenda/live.js';

/** Prueba el adaptador live sustituyendo el cliente del SDK por un doble (sin red). */
function makeGateway() {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const gw = new LiveCoinsendaGateway({
    domain: 'bitsenda.com',
    email: 'ops@cuypay.com',
    privateKeyPem: pem,
    brebDepositAccountId: 'dacc_1',
    copAccountId: 'acc_cop',
    logger: pino({ level: 'silent' }),
  });
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const sessionJwt = jwt.sign({ usr: 'cs_user', exp }, 'x');
  const log: { op: string; arg: any }[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
  let resolveStatus = 401;
  const fake = {
    jwt: null as string | null,
    setJwt(t: string) {
      this.jwt = t;
    },
    setRefreshToken() {},
    setCountry() {},
    getUserId() {
      return 'cs_user';
    },
    async request(service: string, method: string, endpoint: string, data: any, options: any) {
      if (endpoint === '/depositProviders/create-deposit-provider-by-account-id-public') {
        return this.deposit.depositProvider.createDepositProviderByAccountIdPublic(data?.data ?? data);
      }
      if (endpoint === '/withdrawAccounts/resolve-breb-alias-public') {
        return this.withdraw.withdrawAccount.resolveBrebAliasPublic(data?.data ?? data);
      }
      if (endpoint === '/withdrawAccounts/add-new-withdraw-account') {
        return this.withdraw.withdrawAccount.addNewWithdrawAccount(data?.data ?? data);
      }
      if (endpoint === '/withdraws/add-new-withdraw-public') {
        return this.withdraw.withdraw.addNewWithdrawPublic(data?.data ?? data);
      }
      if (endpoint === '/withdraws/add-update-withdraw') {
        return this.withdraw.withdraw.addUpdateWithdraw(data?.data ?? data);
      }
      return { status: 404, data: {} };
    },
    auth: {
      passport: {
        authPubkey: async (arg: any) => { // eslint-disable-line @typescript-eslint/no-explicit-any
          log.push({ op: 'authPubkey', arg });
          return { status: 200, data: { data: { jwt: sessionJwt, refresh_token: 'rt' } } };
        },
      },
      oauth: { grantRefreshToken: async () => ({ status: 401, data: {} }) },
    },
    deposit: {
      depositProvider: {
        createDepositProviderByAccountIdPublic: async (arg: any) => { // eslint-disable-line @typescript-eslint/no-explicit-any
          log.push({ op: 'createDP', arg });
          return { status: 200, data: { data: { id: 'dp_9', state: 'active' } } };
        },
      },
      user: {
        __get__deposits: async (arg: any) => { // eslint-disable-line @typescript-eslint/no-explicit-any
          log.push({ op: 'deposits', arg });
          return {
            status: 200,
            data: [
              { id: 'd1', currency: 'cop', amount: '150000.50', state: 'accepted', deposit_provider_id: 'dp_9', created_at: '2026-11-07T10:00:00Z' },
              { id: 'd2', currency: 'usdt', amount: '1', state: 'accepted' },
            ],
          };
        },
      },
    },
    withdraw: {
      withdrawAccount: {
        resolveBrebAliasPublic: async (arg: any) => { // eslint-disable-line @typescript-eslint/no-explicit-any
          log.push({ op: 'resolve', arg });
          if (resolveStatus === 401) {
            resolveStatus = 200;
            return { status: 401, data: {} };
          }
          if (arg.alias === '@libre') return { status: 400, data: { error: { code: 'withdrawaccount_23', message: 'Cannot resolve breb alias' } } };
          return { status: 200, data: { data: { first_name: 'Juan', last_name: 'Pérez', id_type: 'CC', id_number: '123', bank_name: 'Bancolombia' } } };
        },
        addNewWithdrawAccount: async (arg: any) => { // eslint-disable-line @typescript-eslint/no-explicit-any
          log.push({ op: 'addWithdrawAccount', arg });
          return { status: 200, data: { data: { id: 'wa_1' } } };
        },
        updateVisibility: async () => ({ status: 200, data: {} }),
      },
      withdraw: {
        addNewWithdrawPublic: async (arg: any) => { // eslint-disable-line @typescript-eslint/no-explicit-any
          log.push({ op: 'withdraw', arg });
          return { status: 200, data: { data: { id: 'wd_1', state: 'pending' } } };
        },
        addUpdateWithdraw: async (arg: any) => { // eslint-disable-line @typescript-eslint/no-explicit-any
          log.push({ op: 'confirm', arg });
          return { status: 200, data: { data: { id: 'wd_1', state: 'confirmed' } } };
        },
      },
      user: { __get__withdraws: async () => ({ status: 200, data: [{ id: 'wd_1', state: 'accepted' }] }) },
    },
  };
  (gw as unknown as { client: unknown }).client = fake;
  return { gw, log, publicKey, fake };
}

describe('Coinsenda live adapter (SDK doble)', () => {
  it('autentica con {email, iat} RS256 firmado con la clave privada y re-autentica ante 401', async () => {
    const { gw, log, publicKey } = makeGateway();
    const holder = await gw.resolveBrebAlias('3001234567');
    expect(holder).toMatchObject({ firstName: 'Juan', lastName: 'Pérez', documentNumber: '123', bankName: 'Bancolombia' });
    const auths = log.filter((l) => l.op === 'authPubkey');
    expect(auths).toHaveLength(2); // login inicial + re-auth tras el 401
    const token = auths[0]!.arg.data.signed_token as string;
    const claims = jwt.verify(token, publicKey.export({ type: 'spki', format: 'pem' }).toString(), { algorithms: ['RS256'] }) as jwt.JwtPayload;
    expect(claims.email).toBe('ops@cuypay.com');
    expect(typeof claims.iat).toBe('number');
    expect(claims.exp! - claims.iat!).toBe(300);
  });

  it('withdrawaccount_23 = llave no encontrada (null), no error', async () => {
    const { gw } = makeGateway();
    await gw.resolveBrebAlias('x'); // consume el 401 simulado
    expect(await gw.resolveBrebAlias('@libre')).toBeNull();
  });

  it('crea llave, retiro + confirmación y lee depósitos COP', async () => {
    const { gw, log } = makeGateway();
    const k = await gw.createBrebKey({ alias: '@cuypayana1', holderName: 'Ana', userRef: 'usr_1' });
    expect(k).toMatchObject({ providerKeyId: 'dp_9', status: 'active' });
    expect(log.find((l) => l.op === 'createDP')!.arg).toMatchObject({ deposit_account_id: 'dacc_1', account_id: 'acc_cop' });

    const w = await gw.createWithdraw({ withdrawAccountId: 'wa_1', amountMinor: 15_000_050n, reference: 'txn_1' });
    expect(w.withdrawId).toBe('wd_1');
    expect(log.find((l) => l.op === 'withdraw')!.arg).toMatchObject({ account_id: 'acc_cop', withdraw_account_id: 'wa_1', amount: '150000.50' });
    expect((await gw.confirmWithdraw('wd_1')).state).toBe('confirmed');
    expect(log.find((l) => l.op === 'confirm')!.arg).toEqual({ withdraw_id: 'wd_1', state: 'confirmed', country: 'international' });
    expect((await gw.getWithdraw('wd_1'))!.state).toBe('accepted');

    const deps = await gw.listDeposits();
    expect(log.find((l) => l.op === 'deposits')!.arg).toEqual({ order: 'id DESC', limit: 200 });
    expect(deps).toHaveLength(1);
    expect(deps[0]).toMatchObject({ id: 'd1', providerKeyId: 'dp_9', amountMinor: 15_000_050n, state: 'accepted' });
  });

  it('emite tarjeta virtual Visa COP creando un CardHolder individual desde Sumsub sin reutilizar titulares ajenos', async () => {
    const { gw } = makeGateway();
    const calls: { service: string; method: string; endpoint: string; data: any; options: any }[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
    let cardIssued = false;
    let cardHolderAttached = false;
    const holders: any[] = [ // eslint-disable-line @typescript-eslint/no-explicit-any
      {
        id: 'ch_kevin',
        provider: 'mono_cop',
        info_needed: {
          name: 'Kevin',
          surname: 'Echeverri',
          email: 'ops@cuypay.com',
          id_number: '1005028744',
          id_type: 'cedula_ciudadania',
        },
      },
    ];

    const baseFake = (gw as unknown as { client: any }).client; // eslint-disable-line @typescript-eslint/no-explicit-any
    const origRequest = baseFake.request.bind(baseFake);
    baseFake.request = async (service: string, method: string, endpoint: string, data: any, options: any) => { // eslint-disable-line @typescript-eslint/no-explicit-any
      calls.push({ service, method, endpoint, data, options });
      if (endpoint === '/users/{id}/ledgerAccounts') {
        return { status: 200, data: [{ id: 'lacc_cop_1', currency: 'cop', provider: 'mono_cop' }] };
      }
      if (endpoint === '/users/{id}/cardHolders') {
        return { status: 200, data: [...holders] };
      }
      if (endpoint === '/cardHolders/add-new-card-holder-public') {
        const created = {
          id: 'ch_bryan',
          provider: 'mono_cop',
          info_needed: data.data.info_needed,
        };
        holders.push(created);
        return { status: 200, data: { data: created } };
      }
      if (endpoint === '/products') {
        return {
          status: 200,
          data: [
            {
              id: 'prod_vcard_cop',
              key: 'coinsenda-virtual-cop-card',
              name: 'Tarjeta virtual Coinsenda Visa en COP',
              status: 'available',
              stocks: [{ id: 'stk_1', available: '100', shipping_provider_id: 'sprov_1' }],
            },
          ],
        };
      }
      if (endpoint === '/users/{id}/shippingAddresses') {
        return { status: 200, data: [] };
      }
      if (endpoint === '/shippingAddresses/add-new-shipping-address-public') {
        return { status: 200, data: { data: { id: 'saddr_1', address_type: 'digital', transport_type: 'email' } } };
      }
      if (endpoint === '/sales/add-new-sale-public') {
        cardIssued = true;
        return { status: 200, data: { data: { id: 'sale_1', trade_ids: ['trd_1'], state: 'accepted' } } };
      }
      if (endpoint === '/cards/assign-active-card-to-confirmed-cards-public') {
        return { status: 200, data: { data: { assigned: 1 } } };
      }
      if (endpoint === '/users/{id}/cards') {
        if (!cardIssued) return { status: 200, data: [] };
        return {
          status: 200,
          data: [
            {
              id: 'cs_kev_old',
              trade_id: 'trd_0',
              ledger_account_id: 'lacc_cop_1',
              card_holder_id: 'ch_kevin',
              last_four: '1111',
              working_state: 'active',
            },
            {
              id: 'cs_card_1',
              trade_id: 'trd_1',
              ledger_account_id: 'lacc_cop_1',
              card_holder_id: cardHolderAttached ? 'ch_bryan' : null,
              last_four: cardHolderAttached ? '9876' : null,
              working_state: 'active',
            },
          ],
        };
      }
      if (endpoint === '/cards/attach-card-holder-public') {
        cardHolderAttached = true;
        return { status: 200, data: { data: { ok: true } } };
      }
      if (endpoint === '/cards/get-card-look-url-public') {
        return { status: 200, data: { data: { url: 'https://iframe.pomelo.la/look/cs_card_1' } } };
      }
      if (endpoint === '/cards/update-working-state-public') {
        return { status: 200, data: { data: { ok: true } } };
      }
      if (endpoint === '/cards/update-label-public') {
        return { status: 200, data: { data: { ok: true } } };
      }
      return origRequest(service, method, endpoint, data, options);
    };

    const issued = await gw.issueCard({
      userId: 'usr_1',
      holderName: 'Bryan Ortiz',
      email: 'bryan@cuypay.com',
      currency: 'COP',
      label: 'CuyPay Virtual!',
      holder: {
        firstName: 'Bryan',
        lastName: 'Ortiz',
        email: 'bryan@cuypay.com',
        phone: '+573154103795',
        birthdate: '2003-09-04',
        nationality: 'COL',
        documentCountry: 'COL',
        documentType: 'cedula_ciudadania',
        documentNumber: '1032489123',
        address: {
          country: 'COL',
          province: 'Bogotá D.C.',
          city: 'Bogotá',
          zipCode: '110111',
          streetName: 'Carrera 15',
          streetNumber: '88',
          additionalInfo: 'Apto 402',
        },
      },
    });

    expect(issued).toMatchObject({
      providerCardId: 'cs_card_1',
      providerCardHolderId: 'ch_bryan',
      holderName: 'Bryan Ortiz',
      ledgerAccountId: 'lacc_cop_1',
      lastFour: '9876',
      brand: 'Visa',
      status: 'active',
    });

    const createHolderCall = calls.find((c) => c.endpoint === '/cardHolders/add-new-card-holder-public')!;
    expect(createHolderCall).toBeDefined();
    expect(createHolderCall.options).toEqual({ rawPayload: true });
    expect(createHolderCall.data).toMatchObject({
      data: {
        country: 'international',
        currency: 'cop',
        info_needed: {
          id_country: 'colombia',
          person_type: 'natural',
          name: 'Bryan',
          surname: 'Ortiz',
          email: 'bryan@cuypay.com',
          phone_number: '573154103795',
          nationality: 'colombia',
          id_number: '1032489123',
          id_type: 'cedula_ciudadania',
          country: 'colombia',
          province: 'cundinamarca',
          city: 'bogota',
          zip_code: '110111',
          street_name: 'Carrera 15',
          street_number: '88',
          additional_info: 'Apto 402',
        },
      },
    });
    expect(Number(createHolderCall.data.data.info_needed.birthdate)).toBeGreaterThan(1_000_000_000);

    const saleCall = calls.find((c) => c.endpoint === '/sales/add-new-sale-public')!;
    expect(saleCall.options).toEqual({ rawPayload: true });
    expect(saleCall.data).toEqual({
      data: {
        country: 'international',
        shipping_address_ids: ['saddr_1'],
        products: [
          {
            product_id: 'prod_vcard_cop',
            quantity: 1,
            ledger_account_id: 'lacc_cop_1',
            card_label: 'CuyPay Virtual',
            card_holder_id: 'ch_bryan',
          },
        ],
      },
    });

    const look = await gw.getCardLookUrl('cs_card_1', 'ch_bryan');
    expect(look.url).toBe('https://iframe.pomelo.la/look/cs_card_1');
    const lookCall = calls.find((c) => c.endpoint === '/cards/get-card-look-url-public')!;
    expect(lookCall.data).toEqual({
      data: {
        card_id: 'cs_card_1',
        ledger_account_id: 'lacc_cop_1',
        cardholder_id: 'ch_bryan',
        country: 'international',
      },
    });

    await gw.updateCardWorkingState('cs_card_1', 'frozen');
    expect(calls.find((c) => c.endpoint === '/cards/update-working-state-public')!.data).toEqual({
      data: { card_id: 'cs_card_1', new_working_state: 'frozen', country: 'international' },
    });

    await gw.updateCardLabel('cs_card_1', 'Compras Online');
    expect(calls.find((c) => c.endpoint === '/cards/update-label-public')!.data).toEqual({
      data: { card_id: 'cs_card_1', new_label: 'Compras Online', country: 'international' },
    });
  });
});

