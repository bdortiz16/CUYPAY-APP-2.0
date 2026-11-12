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

  it('no reutiliza un CardHolder previo si el correo o celular cambió (ej. usuario@cuypay.com -> correo real)', async () => {
    const { gw } = makeGateway();
    const calls: { endpoint: string; data: any }[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
    let cardIssued = false;
    const holders: any[] = [ // eslint-disable-line @typescript-eslint/no-explicit-any
      {
        id: 'ch_stale_placeholder',
        provider: 'mono_cop',
        info_needed: {
          name: 'Usuario',
          surname: 'CuyPay',
          email: 'usuario@cuypay.com',
          phone_number: '573005182067',
          id_number: '1987654321',
          id_type: 'cedula_ciudadania',
        },
      },
    ];

    const baseFake = (gw as unknown as { client: any }).client; // eslint-disable-line @typescript-eslint/no-explicit-any
    const origRequest = baseFake.request.bind(baseFake);
    baseFake.request = async (service: string, method: string, endpoint: string, data: any, options: any) => { // eslint-disable-line @typescript-eslint/no-explicit-any
      calls.push({ endpoint, data });
      if (endpoint === '/users/{id}/ledgerAccounts') {
        return { status: 200, data: [{ id: 'lacc_cop_1', currency: 'cop', provider: 'mono_cop' }] };
      }
      if (endpoint === '/users/{id}/cardHolders') {
        return { status: 200, data: [...holders] };
      }
      if (endpoint === '/cardHolders/add-new-card-holder-public') {
        const created = {
          id: 'ch_verified_real',
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
              status: 'available',
              stocks: [{ id: 'stk_1', available: '10', shipping_provider_id: 'sprov_1' }],
            },
          ],
        };
      }
      if (endpoint === '/users/{id}/shippingAddresses') {
        return { status: 200, data: [{ id: 'saddr_1', address_type: 'digital' }] };
      }
      if (endpoint === '/sales/add-new-sale-public') {
        cardIssued = true;
        return { status: 200, data: { data: { id: 'sale_2', trade_ids: ['trd_2'], state: 'accepted' } } };
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
              id: 'cs_card_real',
              trade_id: 'trd_2',
              ledger_account_id: 'lacc_cop_1',
              card_holder_id: 'ch_verified_real',
              last_four: '4455',
              working_state: 'active',
            },
          ],
        };
      }
      return origRequest(service, method, endpoint, data, options);
    };

    const issued = await gw.issueCard({
      userId: 'usr_legacy',
      holderName: 'Andrés Martínez',
      email: 'andres.martinez@gmail.com',
      currency: 'COP',
      label: 'CuyPay Virtual',
      holder: {
        existingCardHolderId: 'ch_stale_placeholder',
        firstName: 'Andrés',
        lastName: 'Martínez',
        email: 'andres.martinez@gmail.com',
        phone: '+573154103799',
        birthdate: '1995-04-12',
        nationality: 'COL',
        documentCountry: 'COL',
        documentType: 'cedula_ciudadania',
        documentNumber: '1987654321',
      },
    });

    expect(issued.providerCardHolderId).toBe('ch_verified_real');
    expect(issued.holderName).toBe('Andrés Martínez');
    const createHolderCall = calls.find((c) => c.endpoint === '/cardHolders/add-new-card-holder-public')!;
    expect(createHolderCall).toBeDefined();
    expect(createHolderCall.data.data.info_needed).toMatchObject({
      email: 'andres.martinez@gmail.com',
      phone_number: '573154103799',
      name: 'Andrés',
      surname: 'Martínez',
    });
  });

  it('transfiere sin costo entre cuenta principal COP y card_mirror, sincroniza topes por tarjeta e ignora depósitos internos', async () => {
    const { gw } = makeGateway();
    const calls: { service: string; method: string; endpoint: string; data: any }[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
    const baseFake = (gw as unknown as { client: any }).client; // eslint-disable-line @typescript-eslint/no-explicit-any
    const origRequest = baseFake.request.bind(baseFake);

    baseFake.deposit.user.__get__deposits = async () => ({
      status: 200,
      data: [
        { id: 'dep_breb_1', currency: 'cop', amount: '50000', state: 'accepted', deposit_provider_id: 'dp_9', provider_type: 'breb' },
        { id: 'dep_internal_1', currency: 'cop', amount: '20000', state: 'accepted', provider_type: 'internal_network' },
        { id: 'dep_internal_2', currency: 'cop', amount: '10000', state: 'accepted', origin: 'internal' },
      ],
    });

    baseFake.request = async (service: string, method: string, endpoint: string, data: any, options: any) => { // eslint-disable-line @typescript-eslint/no-explicit-any
      calls.push({ service, method, endpoint, data });
      if (endpoint === '/users/{id}/ledgerAccounts') {
        return { status: 200, data: [{ id: 'lacc_cop_1', currency: 'cop', account_id: 'acc_card_mirror' }] };
      }
      if (endpoint === '/withdraws/add-new-self-transfer-public') {
        return { status: 200, data: { data: { id: 'st_live_1', state: 'pending', cost: '0' } } };
      }
      if (endpoint === '/users/{id}/cards') {
        return { status: 200, data: [{ id: 'cs_card_99', card_spending_control_id: null }] };
      }
      if (endpoint === '/users/{id}/cardSpendingControls') {
        return { status: 200, data: [] };
      }
      if (endpoint === '/cardSpendingControls/add-new-card-spending-control-public') {
        return { status: 200, data: { data: { id: 'csc_1' } } };
      }
      if (endpoint === '/cards/assign-card-spending-control-public') {
        return { status: 200, data: { data: { ok: true } } };
      }
      if (endpoint === '/users/{id}/cardTransactions') {
        return {
          status: 200,
          data: [
            {
              id: 'ctx_1',
              card_id: 'cs_card_99',
              local_amount: '18500',
              merchant_name: 'Uber Rides',
              status: 'approved',
              created_at: '2026-11-11T15:00:00Z',
            },
          ],
        };
      }
      return origRequest(service, method, endpoint, data, options);
    };

    const toCard = await gw.transferCardPocketFunds({ direction: 'to_card', amountMinor: 2_500_000n });
    expect(toCard.transferId).toBe('st_live_1');
    const selfTxCalls = calls.filter((c) => c.endpoint === '/withdraws/add-new-self-transfer-public');
    expect(selfTxCalls[0]!.data).toEqual({
      data: {
        country: 'international',
        account_id: 'acc_cop',
        account_to: 'acc_card_mirror',
        amount: '25000',
      },
    });

    await gw.transferCardPocketFunds({ direction: 'from_card', amountMinor: 1_000_000n });
    expect(selfTxCalls.length >= 1 || calls.filter((c) => c.endpoint === '/withdraws/add-new-self-transfer-public').length === 2).toBe(true);
    const secondSelfTx = calls.filter((c) => c.endpoint === '/withdraws/add-new-self-transfer-public')[1]!;
    expect(secondSelfTx.data).toEqual({
      data: {
        country: 'international',
        account_id: 'acc_card_mirror',
        account_to: 'acc_cop',
        amount: '10000',
      },
    });

    await gw.syncCardSpendingLimit({ providerCardId: 'cs_card_99', allowedAmountMinor: 1_500_000n });
    const createCtrl = calls.find((c) => c.endpoint === '/cardSpendingControls/add-new-card-spending-control-public')!;
    expect(createCtrl.data).toEqual({
      data: {
        currency: 'cop',
        label: 'CuyPay Pocket ard_99',
        rules: { purchase_limits: { daily: '15000', weekly: '15000', monthly: '15000' } },
        country: 'international',
      },
    });
    const assignCtrl = calls.find((c) => c.endpoint === '/cards/assign-card-spending-control-public')!;
    expect(assignCtrl.data).toEqual({
      data: {
        card_id: 'cs_card_99',
        card_spending_control_id: 'csc_1',
        country: 'international',
      },
    });

    const cardTxns = await gw.listCardTransactions();
    expect(cardTxns).toHaveLength(1);
    expect(cardTxns[0]).toMatchObject({
      id: 'ctx_1',
      providerCardId: 'cs_card_99',
      amountMinor: 1_850_000n,
      merchantName: 'Uber Rides',
      state: 'accepted',
    });

    const deposits = await gw.listDeposits();
    expect(deposits).toHaveLength(1);
    expect(deposits[0]!.id).toBe('dep_breb_1');
  });

  it('configura depositProviderUserConfig (alias_prefix, name, surname, merchant_name), suscribe depósitos en vivo y extrae payerName', async () => {
    const { gw } = makeGateway();
    const calls: { endpoint: string; data: any }[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
    const baseFake = (gw as unknown as { client: any }).client; // eslint-disable-line @typescript-eslint/no-explicit-any
    const origRequest = baseFake.request.bind(baseFake);

    baseFake.request = async (service: string, method: string, endpoint: string, data: any, options: any) => { // eslint-disable-line @typescript-eslint/no-explicit-any
      calls.push({ endpoint, data });
      if (endpoint === '/depositAccounts') {
        return { status: 200, data: [{ id: 'dacc_1', provider_type: 'breb' }] };
      }
      if (endpoint === '/users/{id}/depositProviderUserConfigs') {
        return {
          status: 200,
          data: [{ id: 'dpuc_1', account_id: 'acc_cop', provider_type: 'breb', custom: { alias_prefix: 'xatechservic', custom_alias: '@vieja' } }],
        };
      }
      if (endpoint === '/depositProviderUserConfigs/update-deposit-provider-user-config-public') {
        return { status: 200, data: { data: { id: 'dpuc_1', custom: data.data.custom } } };
      }
      if (endpoint === '/depositProviders/create-deposit-provider-by-account-id-public') {
        return {
          status: 200,
          data: {
            data: {
              id: 'dp_bryan_1',
              state: 'confirmed',
              account: { account_id: { type: 'breb', account_id: '@xatechservic849201' } },
            },
          },
        };
      }
      if (endpoint === '/depositProviders/subscribe-to-new-deposits') {
        return { status: 200, data: { data: { subscribed: true } } };
      }
      if (endpoint === '/depositProviders/cancel-deposit-provider-public') {
        return { status: 404, data: { error: { code: 'depositprovider_not_found' } } };
      }
      return origRequest(service, method, endpoint, data, options);
    };

    baseFake.deposit.user.__get__deposits = async () => ({
      status: 200,
      data: [
        {
          id: 'dep_payer_1',
          currency: 'cop',
          amount: '75000',
          state: 'accepted',
          deposit_provider_id: 'dp_bryan_1',
          info: { sender_name: 'María Fernanda Gómez' },
        },
      ],
    });

    const created = await gw.createBrebKey({
      alias: '@xatechservic123456',
      holderName: 'Bryan Ortiz',
      userRef: 'usr_bryan',
    });

    expect(created).toMatchObject({
      providerKeyId: 'dp_bryan_1',
      alias: '@xatechservic849201',
      status: 'active',
    });

    const cfgCall = calls.find((c) => c.endpoint === '/depositProviderUserConfigs/update-deposit-provider-user-config-public')!;
    expect(cfgCall).toBeDefined();
    expect(cfgCall.data).toMatchObject({
      data: {
        deposit_provider_user_config_id: 'dpuc_1',
        country: 'international',
        recaptcha_response: 'BYPASS_RECAPTCHA_DEV',
        custom: {
          alias_prefix: 'xatechservic',
          name: 'Bryan',
          surname: 'Ortiz',
          merchant_name: 'CuyPay',
        },
      },
    });
    expect(cfgCall.data.data.custom.custom_alias).toBeUndefined();
    expect(cfgCall.data.data.userId).toBeUndefined();

    const createCall = calls.find((c) => c.endpoint === '/depositProviders/create-deposit-provider-by-account-id-public')!;
    expect(createCall.data).toMatchObject({
      data: {
        account_id: 'acc_cop',
        deposit_account_id: 'dacc_1',
        country: 'international',
        recaptcha_response: 'BYPASS_RECAPTCHA_DEV',
      },
    });
    expect(createCall.data.data.alias).toBeUndefined();
    expect(createCall.data.data.userId).toBeUndefined();

    const subscribeCall = calls.find((c) => c.endpoint === '/depositProviders/subscribe-to-new-deposits')!;
    expect(subscribeCall).toBeDefined();
    expect(subscribeCall.data).toMatchObject({
      data: {
        account_id: 'acc_cop',
        deposit_provider_id: 'dp_bryan_1',
        country: 'international',
      },
    });

    // cancelBrebKey es idempotente ante 404
    await expect(gw.cancelBrebKey('dp_inexistente')).resolves.toBeUndefined();

    const deps = await gw.listDeposits();
    expect(deps).toHaveLength(1);
    expect(deps[0]).toMatchObject({
      id: 'dep_payer_1',
      providerKeyId: 'dp_bryan_1',
      amountMinor: 7_500_000n,
      payerName: 'María Fernanda Gómez',
    });
  });
});
