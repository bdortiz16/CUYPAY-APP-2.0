import type { Role } from "./types";

// Permisos del backend (backend/src/services/admin/rbac.ts). GET /admin/me devuelve
// `permissions: string[]`; la UI los usa para ocultar/deshabilitar acciones. Si no llegan,
// se usa esta matriz por rol como respaldo. El backend sigue siendo la autoridad.
export type Permission =
  | "dashboard:read"
  | "pii:read"
  | "customers:freeze"
  | "customers:limits"
  | "customers:support"
  | "compliance:read"
  | "compliance:decide"
  | "treasury:read"
  | "treasury:write"
  | "limits:write"
  | "providers:check"
  | "admins:manage"
  | "audit:read";

const MATRIX: Record<Permission, Role[]> = {
  "dashboard:read": ["owner", "compliance", "treasury", "support", "viewer"],
  "pii:read": ["owner", "compliance", "support"],
  "customers:freeze": ["owner", "compliance"],
  "customers:limits": ["owner", "compliance"],
  "customers:support": ["owner", "compliance", "support"],
  "compliance:read": ["owner", "compliance"],
  "compliance:decide": ["owner", "compliance"],
  "treasury:read": ["owner", "compliance", "treasury", "viewer"],
  "treasury:write": ["owner", "treasury"],
  "limits:write": ["owner", "compliance"],
  "providers:check": ["owner", "compliance", "treasury"],
  "admins:manage": ["owner"],
  "audit:read": ["owner", "compliance"],
};

export function permissionsForRole(role: Role): Permission[] {
  return (Object.keys(MATRIX) as Permission[]).filter((p) => MATRIX[p].includes(role));
}

export function can(
  role: Role | undefined | null,
  permission: Permission,
  permissions?: readonly string[] | null,
): boolean {
  if (permissions && permissions.length) return permissions.includes(permission);
  if (!role) return false;
  return MATRIX[permission].includes(role);
}

export const ROLE_LABEL: Record<Role, string> = {
  owner: "Owner",
  compliance: "Cumplimiento",
  treasury: "Tesorería",
  support: "Soporte",
  viewer: "Solo lectura",
};

export const ROLES: Role[] = ["owner", "compliance", "treasury", "support", "viewer"];
