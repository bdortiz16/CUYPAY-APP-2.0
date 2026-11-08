import type { AdminRole } from '../src/domain/admin.js';
import { generateTotp, generateTotpSecret } from '../src/lib/totp.js';
import type { TestEnv } from './helpers.js';

export interface AdminSessionT {
  token: string;
  adminId: string;
  email: string;
  password: string;
  totpSecret: string;
}

let seq = 0;

/** Crea un admin con el rol dado y hace login completo (contraseña + TOTP). */
export async function adminLogin(env: TestEnv, role: AdminRole = 'owner'): Promise<AdminSessionT> {
  const email = `${role}${++seq}@admin.cuypay.test`;
  const password = 'Admin-Test-Password-123';
  const totpSecret = generateTotpSecret();
  const admin = await env.container.services.admin.auth.createRaw({ email, name: `Admin ${role}`, role, password, totpSecret });
  const token = await loginWith(env, email, password, totpSecret);
  return { token, adminId: admin.id, email, password, totpSecret };
}

export async function loginWith(env: TestEnv, email: string, password: string, totpSecret: string): Promise<string> {
  const l = await env.app.inject({ method: 'POST', url: '/v1/admin/auth/login', payload: { email, password } });
  if (l.statusCode !== 200) throw new Error(`admin login ${l.statusCode} ${l.body}`);
  const code = generateTotp(totpSecret, env.clock.now());
  const m = await env.app.inject({ method: 'POST', url: '/v1/admin/auth/mfa', payload: { mfaToken: l.json().mfaToken, code } });
  if (m.statusCode !== 200) throw new Error(`admin mfa ${m.statusCode} ${m.body}`);
  return m.json().accessToken as string;
}

/** Llamada a /v1/admin/* con el token admin. */
export async function adminCall(env: TestEnv, token: string, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, body?: unknown) {
  const res = await env.app.inject({
    method,
    url,
    payload: body === undefined ? undefined : JSON.stringify(body),
    headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
  });
  let parsed: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  try {
    parsed = res.body ? JSON.parse(res.body) : undefined;
  } catch {
    parsed = res.body;
  }
  return { status: res.statusCode, body: parsed, headers: res.headers, raw: res.body };
}
