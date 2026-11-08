# CuyPay iOS

La app iOS de CuyPay. Con ella el usuario:

- recibe COP en su propia **llave Bre-B**;
- maneja dos bolsillos, **COP 🇨🇴** y **BRL 🇧🇷**;
- **convierte COP → BRL**;
- **envía COP por Bre-B** a sus beneficiarios inscritos.

Usa SwiftUI con el diseño **Liquid Glass** de iOS 26. Las operaciones sensibles se firman con una llave del **Secure Enclave** y requieren Face ID.

El contrato con el backend es [`docs/API_CONTRACT.md`](../docs/API_CONTRACT.md) y es vinculante.

## Requisitos

| Herramienta | Versión |
|---|---|
| Xcode | 26 o superior (SDK iOS 26) |
| iOS (deployment target) | 26.0 |
| Swift | 6, con strict concurrency `complete` |
| XcodeGen | `brew install xcodegen` |

```bash
cd ios
xcodegen generate      # genera CuyPay.xcodeproj a partir de project.yml
open CuyPay.xcodeproj
```

El único paquete externo es **Sumsub IdensicMobileSDK** (SPM, desde `1.47.0`). Xcode lo resuelve solo al abrir el proyecto.

> El `.xcodeproj` es un archivo generado: no lo edites a mano ni lo subas al repo. Cualquier cambio de configuración se hace en `project.yml` y luego se vuelve a correr `xcodegen generate`.

## Entornos: mock / dev / prod

| Esquema | Configuración | API | Modo por defecto |
|---|---|---|---|
| `CuyPay-Dev` | `Dev` (debug) | `http://localhost:8080/v1` | **mock**, con la variable de entorno `CUYPAY_API_MODE=mock` del esquema |
| `CuyPay-Prod` | `Prod` (release) | `https://api.cuypay.com/v1` | **live**; en Release el mock queda deshabilitado por código |

Los valores de base se definen en `Config/Dev.xcconfig` y `Config/Prod.xcconfig`. Pasan al Info.plist como `CuyPayAPIBaseURL`, `CuyPayAPIMode` y `CuyPayEnvironmentName`.

Las variables de entorno del esquema tienen prioridad sobre el Info.plist. Se configuran en *Edit Scheme → Run → Arguments*:

- `CUYPAY_API_MODE`: `mock` o `live`.
- `CUYPAY_API_BASE_URL`: por ejemplo `http://192.168.1.10:8080/v1` para probar en un iPhone físico contra tu Mac.

**Para usar el backend local:** en el esquema `CuyPay-Dev` desmarca `CUYPAY_API_MODE` o cámbiala a `live`, y levanta el backend en `localhost:8080`. El OTP de desarrollo es `123456`. El Info.plist permite `http://localhost` con `NSAllowsLocalNetworking`; ATS sigue exigiendo HTTPS para el resto de dominios.

### Modo mock (`MockAPIClient`)

Funciona sin backend y con datos realistas. Es el modo por defecto en los previews y en `CuyPay-Dev`.

- En la bienvenida, **"Explorar demo"** entra directo con la cuenta de demostración Ana Gómez (`@cuypayana123`).
- El OTP es `123456`.
- La verificación KYC se aprueba sola unos 4 s después de lanzarla.
- Llaves "mágicas" para probar el flujo de inscribir beneficiarios:

| Llave | Resultado |
|---|---|
| contiene `noexiste` o termina en `0000` | `BREB_ALIAS_NOT_FOUND` |
| contiene `revision` o termina en `9999` | AML → `pending_review` |
| contiene `rechazo` o termina en `6666` | AML → `rejected` |
| cualquier otra | AML aprobado → `active` |

El mock también aplica:

- límites, saldo e idempotencia;
- vencimiento de la cotización (30 s);
- la fórmula `toAmountMinor = floor((fromAmountMinor − feeMinor) × rate)`.

## Arquitectura

```
ios/
├── project.yml                  # XcodeGen (targets, esquemas, Info.plist, SPM)
├── Config/                      # Dev.xcconfig / Prod.xcconfig
├── CuyPay/
│   ├── App/                     # @main, AppModel (rutas, sesión, bloqueo), WalletStore, AppEnvironment
│   ├── Core/
│   │   ├── Money/               # Money (Int64 minor units), AmountInput, RateFormatter
│   │   ├── Models/              # Modelos del contrato + LimitsSnapshot
│   │   ├── Networking/          # CuyPayAPI (protocolo), APIClient (actor), Endpoint, APIError, Mock/
│   │   ├── Security/            # SecureEnclaveKeyManager, RequestSigner, KeychainStore, TokenStore, Biometric
│   │   ├── KYC/                 # KYCService (wrapper de Sumsub)
│   │   └── Utilities/           # QR (CoreImage), agrupación por día
│   ├── DesignSystem/            # Theme, fondo, componentes Liquid Glass, teclado, anillo de cuenta regresiva
│   ├── Features/                # Onboarding, Auth, KYC, Home, Receive, Convert, Send,
│   │                            # Beneficiaries, Limits, Profile, Transactions
│   └── Resources/               # Assets.xcassets, Localizable.xcstrings (Info.plist lo genera XcodeGen)
└── CuyPayTests/                 # Swift Testing: firma, Money, decodificación, límites
```

- **Estado:** modelos `@Observable` aislados en `@MainActor`.
  - `AppModel` maneja la ruta (onboarding / login / main), el usuario, el bloqueo y la cubierta de privacidad.
  - `WalletStore` guarda bolsillos, movimientos, beneficiarios, tasa, límites y la llave Bre-B.
  - Ambos se inyectan con `.environment(...)`.
- **Red:** `APIClient` es un `actor` que implementa `CuyPayAPI`.
  - JSON en camelCase y fechas ISO-8601 (con o sin fracciones).
  - Los errores del contrato se traducen a `APIError`, con mensajes en español.
  - Ante un 401 hace refresh automático, con una sola renovación en vuelo a la vez.
  - Las transferencias y conversiones llevan `idempotencyKey` (UUID) en el body.
  - `MockAPIClient` implementa el mismo protocolo.
- **Dinero:** nunca se usa `Double`.
  - `Money` guarda `Int64` en unidades menores y hace aritmética con detección de overflow.
  - Formato fijo: COP `$ 1.250.000` (los centavos solo aparecen si no son 0) y BRL `R$ 1.823,00`.
  - `AmountInput` arma el monto dígito a dígito.
- **Liquid Glass:** se usan las APIs nativas de iOS 26: `glassEffect(_:in:)`, `GlassEffectContainer`, `glassEffectID(_:in:)` (el selector COP/BRL se transforma de uno a otro) y los estilos `.glass` / `.glassProminent`. El fondo es un degradado claro con manchas menta; en modo oscuro usa navy de marca.

## Modelo de seguridad

1. **Llave del dispositivo:** P-256 en el **Secure Enclave**, creada con `kSecAttrAccessibleWhenUnlockedThisDeviceOnly` y `[.privateKeyUsage, .biometryCurrentSet]`.
   - Cada firma exige Face ID.
   - Si cambian las biometrías, la llave queda invalidada y hay que re-enrolar el dispositivo.
   - En el Keychain solo se guarda `dataRepresentation`, un blob que únicamente puede usar el Secure Enclave de ese iPhone.
   - La clave pública se envía como X9.63 de 65 bytes en base64.
2. **Login sin contraseña:** `POST /auth/challenge` → Face ID → firma DER del `nonce` → `POST /auth/login`.
3. **Operaciones 🔐:** son crear la llave Bre-B, inscribir o borrar beneficiarios, enviar, convertir y borrar dispositivos. `RequestSigner` firma esta cadena canónica:
   ```
   MÉTODO\n/v1/path\nsha256hex(body)\ntimestamp\nnonce
   ```
   y agrega los headers `X-CuyPay-Device`, `X-CuyPay-Timestamp`, `X-CuyPay-Nonce` (UUID v4 en minúsculas) y `X-CuyPay-Signature`.
4. **Tokens:**
   - El access token vive solo en memoria.
   - El refresh token y el `deviceId` van en el Keychain con `ThisDeviceOnly`, así que no viajan en backups ni pasan a otro iPhone.
5. **Bloqueo de la app:**
   - Al pasar a segundo plano se muestra una cubierta de privacidad (blur con el logo).
   - Si la app estuvo más de **2 minutos** en segundo plano, pide Face ID otra vez.
   - El "ojo" oculta los montos en pantalla.
6. **Simulador:** como no tiene Secure Enclave, **solo en DEBUG** se usa una clave P-256 por software y se avisa en consola y en *Perfil y seguridad*. En Release, si no hay Secure Enclave, se lanza un error.

## KYC con Sumsub

- El paquete SPM `IdensicMobileSDK` está declarado en `project.yml`.
- `KYCService` lo envuelve detrás de `#if canImport(IdensicMobileSDK)`, así la app compila aunque se quite el paquete. En ese caso, o en modo mock, la verificación se simula.
- El flujo del token:
  1. La app pide `POST /kyc/sumsub/token` y lanza `SNSMobileSDK(accessToken:)`.
  2. Cuando el SDK lo solicita, `tokenExpirationHandler` pide un token nuevo.
  3. Al cerrarse el SDK, la app consulta `GET /kyc/status`.
- **El App Token y el Secret de Sumsub nunca van en la app:** solo el backend los conoce.
- El Info.plist ya trae los permisos que necesita el SDK: cámara, fotos y micrófono, además de Face ID.

## Localización

- `Resources/Localizable.xcstrings` es un String Catalog con **español (`es`) como idioma fuente** y traducciones **pt-BR** de las cadenas principales, pensadas para el lanzamiento en Brasil.
- Xcode extrae las cadenas nuevas automáticamente al compilar porque `SWIFT_EMIT_LOC_STRINGS` está activo. Las que falten por traducir se completan en el editor del catálogo.
- Los montos usan formato fijo es-CO / pt-BR y no dependen del idioma del teléfono.

## Tests

```bash
xcodebuild test -project CuyPay.xcodeproj -scheme CuyPay-Dev \
  -destination 'platform=iOS Simulator,name=iPhone 17'
```

Cubren:

- la cadena canónica exacta y la verificación de la firma DER con una clave por software;
- el formato y el parseo de `Money` y `AmountInput`;
- la decodificación de las muestras JSON del contrato, incluidos enums desconocidos y errores con `details`;
- los cálculos de límites;
- la detección del tipo de llave Bre-B y la agrupación por día.
