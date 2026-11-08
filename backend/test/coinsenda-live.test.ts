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
        addNewWithdrawAccount: async () => ({ status: 200, data: { data: { id: 'wa_1' } } }),
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
    expect(log.find((l) => l.op === 'confirm')!.arg).toEqual({ withdraw_id: 'wd_1', state: 'confirmed' });
    expect((await gw.getWithdraw('wd_1'))!.state).toBe('accepted');

    const deps = await gw.listDeposits();
    expect(log.find((l) => l.op === 'deposits')!.arg).toEqual({ order: 'id DESC', limit: 200 });
    expect(deps).toHaveLength(1);
    expect(deps[0]).toMatchObject({ id: 'd1', providerKeyId: 'dp_9', amountMinor: 15_000_050n, state: 'accepted' });
  });
});
