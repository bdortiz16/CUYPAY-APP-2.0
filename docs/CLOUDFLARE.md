# CuyPay — Mover cuypay.com de GoDaddy a Cloudflare

Guía 100 % por navegador (sin Terminal). Tiempo: ~30 min + propagación (1–24 h).

> **IMPORTANTE — el correo `info@cuypay.com` (Titan/GoDaddy) NO se debe romper.**
> Solo cambiamos *quién administra el DNS*; el dominio sigue registrado en GoDaddy
> y el correo sigue en Titan. Lo único crítico es conservar los registros MX/TXT.

---

## Paso 0 — Foto de seguridad del DNS actual (GoDaddy)

1. Entra a https://dcc.godaddy.com/control/portfolio → clic en **cuypay.com** → pestaña **DNS**.
2. Toma **capturas de pantalla de TODOS los registros** (especialmente los tipo **MX**, **TXT**, **CNAME**).
3. Guárdalas. Si algo falla, con eso se restaura.

## Paso 1 — Crear cuenta y agregar el dominio en Cloudflare

1. Ve a https://dash.cloudflare.com/sign-up y crea la cuenta con `info@cuypay.com` (activa 2FA en *My Profile → Authentication*).
2. Clic en **+ Add** → **Connect a domain** (o "Agregar un dominio").
3. Escribe `cuypay.com` → deja marcado **Quick scan for DNS records** → **Continue**.
4. Elige el plan **Free** → **Continue**.

## Paso 2 — Revisar los registros importados (lo más importante)

Cloudflare muestra la lista de registros que copió de GoDaddy. Compárala con tus capturas del Paso 0:

| Tipo | Qué es | Proxy (nube naranja) |
|---|---|---|
| **MX** (ej. `mx1.titan.email`, `mx2.titan.email`) | Correo entrante | No aplica — debe existir |
| **TXT** con `v=spf1 ...` | SPF (anti-spam) | No aplica — debe existir |
| **TXT/CNAME** `titan1._domainkey` o similar | DKIM | No aplica — debe existir |
| **TXT** `_dmarc` | DMARC | No aplica |
| **CNAME** `autodiscover`, `mail`, `webmail` | Config. correo | **Gris (DNS only)** |
| TXT de verificación (Google, Apple, etc.) | Verificaciones | No aplica |

- Si falta alguno de tu captura → **Add record** y cópialo igual.
- Los registros `A`/`CNAME` de `@` y `www` que apunten a GoDaddy (sitio "parked" o Website Builder) **puedes borrarlos**: en el Paso 5 los reemplaza Cloudflare Pages.
- Clic en **Continue to activation**.

## Paso 3 — Cambiar los nameservers en GoDaddy

Cloudflare te mostrará **2 nameservers**, algo como `xxxx.ns.cloudflare.com` y `yyyy.ns.cloudflare.com`. Cópialos.

1. GoDaddy → **cuypay.com** → pestaña **DNS** → sub-pestaña **Nameservers** → **Change Nameservers**.
2. Elige **I'll use my own nameservers**.
3. Borra los de GoDaddy y pega los 2 de Cloudflare → **Save** → confirma el aviso.
4. Si GoDaddy tiene **DNSSEC** activado, desactívalo primero (si no, el dominio dejará de resolver).
5. Vuelve a Cloudflare y clic **Check nameservers now**.

Recibirás un email de Cloudflare "**cuypay.com is now active**" (normalmente < 1 h, máximo 24 h).

✅ Prueba: envía un correo a `info@cuypay.com` desde Gmail y verifica que llegue.

## Paso 4 — Seguridad básica (cuando esté *Active*)

En Cloudflare → **cuypay.com**:

1. **SSL/TLS → Overview** → modo **Full (strict)**.
2. **SSL/TLS → Edge Certificates** → activa **Always Use HTTPS**, **Automatic HTTPS Rewrites**, *Minimum TLS* **1.2**.
3. **DNS → Settings** → activa **DNSSEC** y copia los datos que da → en GoDaddy *DNS → DNSSEC* agrégalos (opcional pero recomendado).
4. **Security → Bots** → activa **Bot Fight Mode**.

## Paso 5 — Publicar la web (landing + admin portal) con Cloudflare Pages

La web vive en la carpeta `web/` del repo y se publica sola con GitHub Actions.

**5.1 Crear el token para GitHub**
1. Cloudflare → avatar arriba a la derecha → **My Profile → API Tokens → Create Token**.
2. Plantilla **Edit Cloudflare Workers** → *Use template* → en *Account Resources* tu cuenta → **Continue → Create Token**.
3. Copia el token (solo se muestra una vez). **No lo pegues en el chat.**
4. Copia también tu **Account ID** (Cloudflare → *Workers & Pages* → columna derecha "Account ID").

**5.2 Guardarlos en GitHub**
1. https://github.com/bdortiz16/CUYPAY-APP-2.0/settings/secrets/actions → **New repository secret**.
2. `CLOUDFLARE_API_TOKEN` = el token. Guardar.
3. `CLOUDFLARE_ACCOUNT_ID` = el Account ID. Guardar.
4. Ve a la pestaña **Actions** → workflow **Web** → **Run workflow** (o espera al siguiente push). Esto crea el proyecto `cuypay-web` en Pages.

**5.3 Conectar el dominio**
1. Cloudflare → **Workers & Pages** → **cuypay-web** → pestaña **Custom domains** → **Set up a custom domain**.
2. Escribe `cuypay.com` → *Activate domain*. Repite con `www.cuypay.com`.
3. Para que `cuypay.com` redirija a `www`: **Rules → Redirect Rules → Create rule** → plantilla *Redirect from root to WWW* → Deploy.

✅ Prueba: abre https://www.cuypay.com y https://www.cuypay.com/admin-portal/

## Paso 6 — Proteger `/admin-portal` con Cloudflare Zero Trust (Access)

Así nadie fuera del equipo puede ni siquiera ver la pantalla de login.

1. Cloudflare → **Zero Trust** (menú izquierdo) → elige un *team name* (ej. `cuypay`) → plan **Free** (hasta 50 usuarios).
2. **Access → Applications → Add an application → Self-hosted**.
3. Nombre: `CuyPay Admin`. *Session duration*: 8 h.
4. **Public hostname**: dominio `www.cuypay.com`, path `admin-portal`. Agrega otra línea igual con `cuypay.com` / `admin-portal`.
5. **Policy** → nombre `Equipo CuyPay` → Action **Allow** → Include → **Emails ending in** → `@cuypay.com` (o lista de emails concretos).
6. Login method: **One-time PIN** (llega un código al correo). Guardar.
7. En la app creada, copia el **Application Audience (AUD) tag**; se usará en el backend (`CF_ACCESS_AUD`) junto con `CF_ACCESS_TEAM_DOMAIN=cuypay.cloudflareaccess.com`.

Resultado: `/admin-portal` pide primero el PIN de Cloudflare y luego el usuario + contraseña + código TOTP del portal (doble barrera).

## Paso 7 — (Después) API del backend

Cuando el backend esté desplegado (AWS o Google Cloud):
- **DNS → Add record** → `CNAME` `api` → host del backend → **Proxied (naranja)**.
- El portal usará `https://api.cuypay.com` (`NEXT_PUBLIC_ADMIN_API_BASE`) y la app iOS también.

---

### Si algo sale mal
- **No llega el correo:** revisa que los MX/SPF/DKIM de Titan estén en Cloudflare *DNS → Records* exactamente como en tu captura.
- **"Too many redirects":** SSL/TLS debe estar en *Full (strict)*, no *Flexible*.
- **Volver atrás:** en GoDaddy → Nameservers → *GoDaddy Nameservers (recommended)*.
