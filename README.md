# CuyPay App 2.0 — iOS (Colombia 🇨🇴 → Brasil 🇧🇷)

Billetera CuyPay para iPhone con diseño **Liquid Glass (iOS 26)**, enfocada en el corredor **COP → BRL**:

- **Recibir COP** con la llave **Bre-B** propia del usuario (vía Coinsenda).
- **Dos bolsillos**: COP y BRL.
- **Convertir COP → BRL** con cotización en vivo (30 s) y comisión transparente.
- **Enviar COP por Bre-B** a beneficiarios inscritos y verificados (resolución de titular + AML Sartblock).
- **Seguridad con Face ID** (clave en Secure Enclave, cada operación sensible se firma con biometría).
- **KYC con Sumsub**.
- **Límites diarios, mensuales y anuales**.

## Estructura

| Carpeta | Contenido |
|---|---|
| [`ios/`](ios/) | App SwiftUI (iOS 26+, XcodeGen). Ver [ios/README.md](ios/README.md) |
| [`backend/`](backend/) | API Node.js/TypeScript (Fastify) que integra Coinsenda, Sumsub, Sartblock y el proveedor BRL. Ver [backend/README.md](backend/README.md) |
| [`docs/API_CONTRACT.md`](docs/API_CONTRACT.md) | Contrato único app ↔ backend |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Arquitectura, flujos y seguridad |
| [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) | **Guía de despliegue y lanzamiento** (Apple, nube, legal, TestFlight) |
| [`docs/BRAND.md`](docs/BRAND.md) | Paleta, isotipo y reglas de marca |
| [`docs/ADMIN_API.md`](docs/ADMIN_API.md) | Contrato del back-office `/v1/admin/*` |
| [`docs/CLOUDFLARE.md`](docs/CLOUDFLARE.md) | Migración GoDaddy → Cloudflare, Pages y Zero Trust |
| [`web/`](web/) | Landing www.cuypay.com + `/admin-portal` (Next.js estático → Cloudflare Pages) |
| [`docs/reference/`](docs/reference/) | Referencias de diseño y de la integración Coinsenda Studio |

## Arranque rápido

```bash
# Backend (modo mock, sin credenciales)
cd backend && npm install && npm run dev        # http://localhost:8080/v1

# iOS (en una Mac con Xcode 26)
brew install xcodegen
cd ios && xcodegen generate && open CuyPay.xcodeproj
```
