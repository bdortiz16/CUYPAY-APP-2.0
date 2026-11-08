import type { AdminRole } from '../../domain/admin.js';

/** Matriz de permisos (docs/ADMIN_API.md § Roles y permisos). */
export type Permission =
  | 'dashboard:read' // dashboard, clientes, transacciones, proveedores
  | 'pii:read' // documento / teléfono / correo sin enmascarar
  | 'customers:freeze'
  | 'customers:limits' // tier y overrides de límites
  | 'customers:support' // notas internas y revocar dispositivos
  | 'compliance:read' // colas AML y alertas
  | 'compliance:decide'
  | 'treasury:read'
  | 'treasury:write' // FX, conciliación, reversos
  | 'limits:write'
  | 'providers:check'
  | 'admins:manage'
  | 'audit:read';

const ALL: AdminRole[] = ['owner', 'compliance', 'treasury', 'support', 'viewer'];

export const PERMISSIONS: Record<Permission, readonly AdminRole[]> = {
  'dashboard:read': ALL,
  'pii:read': ['owner', 'compliance', 'support'],
  'customers:freeze': ['owner', 'compliance'],
  'customers:limits': ['owner', 'compliance'],
  'customers:support': ['owner', 'compliance', 'support'],
  'compliance:read': ['owner', 'compliance'],
  'compliance:decide': ['owner', 'compliance'],
  'treasury:read': ['owner', 'compliance', 'treasury', 'viewer'],
  'treasury:write': ['owner', 'treasury'],
  'limits:write': ['owner', 'compliance'],
  'providers:check': ['owner', 'compliance', 'treasury'],
  'admins:manage': ['owner'],
  'audit:read': ['owner', 'compliance'],
};

export const can = (role: AdminRole, p: Permission): boolean => PERMISSIONS[p].includes(role);

export const permissionsOf = (role: AdminRole): Permission[] =>
  (Object.keys(PERMISSIONS) as Permission[]).filter((p) => can(role, p));
