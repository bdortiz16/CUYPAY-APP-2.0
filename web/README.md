# CuyPay Web — www.cuypay.com

Sitio público y back-office de CuyPay. **Next.js (App Router, TypeScript)** exportado como sitio **100 % estático**
(`output: 'export'`, `trailingSlash: true`) y desplegado en **Cloudflare Pages**. CSS vanilla (CSS Modules), sin Tailwind.

| Ruta | Contenido |
|---|---|
| `/` | Landing: calculadora COP → BRL (tasa demo, matemática entera), cómo funciona Bre-B, bolsillos, seguridad, descarga, FAQ |
| `/privacidad/`, `/terminos/` | Borradores legales (Ley 1581 de 2012 / Decreto 1377 de 2013) — **pendientes de revisión legal** |
| `/admin-portal/` | Back-office cliente que implementa [`docs/ADMIN_API.md`](../docs/ADMIN_API.md) (`noindex`) |

## Desarrollo

```bash
cd web
npm install
npm run dev          # http://localhost:3000
npm run typecheck && npm run lint
npm run build        # genera out/
```

## Portal admin

- Login correo + contraseña + **TOTP**; token en memoria + `sessionStorage` (30 min, sin refresh, cierre por inactividad a los 15 min).
- **RBAC** (`owner`, `compliance`, `treasury`, `support`, `viewer`) según la matriz de `ADMIN_API.md`: la navegación se filtra y las acciones sin permiso se deshabilitan. El backend sigue siendo la autoridad.
- **Toda mutación pide `reason`** (diálogo obligatorio) y queda en el audit log.
- Detalles por query string (export estático): `/admin-portal/customers/?id=usr_…`, `/admin-portal/transactions/?id=txn_…`.
- Tiempo real por **SSE** (`POST /admin/stream/token` → `EventSource /admin/stream?token=`), con reconexión exponencial.

### Variables (se incrustan en el build)

| Variable | Uso |
|---|---|
| `NEXT_PUBLIC_ADMIN_API_BASE` | Base del API, ej. `https://api.cuypay.com/v1`. Si no se define → **modo demo** |
| `NEXT_PUBLIC_ADMIN_MOCK=1` | Fuerza el modo demo aunque haya base URL |
| `NEXT_PUBLIC_TESTFLIGHT_URL` | Enlace público de TestFlight (si falta, el botón abre un correo a info@cuypay.com) |

**Modo demo:** datos realistas generados en el navegador (`lib/admin/mock.ts`) con eventos SSE simulados.
Usuarios: `admin@` / `owner@` (owner), `cumplimiento@`, `tesoreria@`, `soporte@`, `lectura@cuypay.com` · contraseña
cualquiera · TOTP: cualquier código de 6 dígitos.

**Backend local (dev):** el seed del backend crea `admin@cuypay.com` / `CuyPay-Admin-Dev-2026!` con secreto TOTP
`CUYPAYDEVADMINTOTPSECRET234567AB` (solo desarrollo; nunca en producción). Login en dos pasos
(`/admin/auth/login` → `/admin/auth/mfa`); tras el MFA el portal llama `GET /admin/me` y usa `permissions` para el RBAC.
Toda mutación pide un motivo (`reason`, 3–1000 caracteres) que queda en el audit log.

> El API debe permitir CORS desde `https://www.cuypay.com` (con `credentials`) y `/admin-portal*` + `/v1/admin*` deben ir detrás de Cloudflare Access.

## Despliegue

- `wrangler.toml` → proyecto Pages `cuypay-web`, salida `out/`.
- `public/_headers` → CSP, HSTS, `X-Frame-Options: DENY`, `noindex` + `no-store` en `/admin-portal/*`.
- `.github/workflows/web.yml` → en PRs/pushes que tocan `web/**`: typecheck, lint y build; en `main` despliega con
  `cloudflare/wrangler-action` (`pages deploy out --project-name=cuypay-web`). Requiere los secretos
  `CLOUDFLARE_API_TOKEN` y `CLOUDFLARE_ACCOUNT_ID`; si faltan, el deploy se omite con un aviso.
  Las variables `NEXT_PUBLIC_*` se configuran como *Variables* del repositorio.

Manual: `npm run build && npx wrangler pages deploy out --project-name=cuypay-web`.
