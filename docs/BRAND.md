# Identidad visual CuyPay

Fuente: *CUYPAY Identity Proposal* — Zarta Studio (paleta en `reference/brand-palette-zarta.png`, moodboard en `reference/brand-moodboard-zarta.png`).

## Paleta principal

| Nombre | HEX | CMYK | Rol en la app | Token iOS |
|---|---|---|---|---|
| Onyx | `#0C1214` | C40 M10 Y0 K92 | **Principal**: texto fuerte, fondo oscuro, pantalla de lanzamiento | `Theme.onyx` / `BrandOnyx` |
| Jet Black | `#152830` | C56 M17 Y0 K81 | Superficies oscuras, degradado modo oscuro | `Theme.jetBlack` / `BrandJetBlack` |
| Dark Slate Grey | `#ADCBC8` | C15 M0 Y1 K20 | Aguamarina suave: manchas del fondo, color interactivo en modo oscuro | `Theme.slate` / `BrandSlate` |
| White | `#FFFFFF` | C0 M0 Y0 K0 | Fondo claro, texto sobre verde | `Color.white` |
| Vibrant Coral | `#FA6465` | C0 M60 Y60 K2 | **Acento**: resaltados ("al mejor precio"), barra del día en la gráfica, punto del isotipo | `Theme.coral` / `BrandCoral` |
| "Turquoise" | `#E1E3EA` | C4 M3 Y0 K8 | Gris claro: final del degradado de fondo | `Theme.mist` / `BrandMist` |
| Blue Spruce | `#197168` | C78 M0 Y8 K56 | Verde de marca: botones principales, tinte del sistema (`AccentColor`), iconos activos | `Theme.spruce` · `Theme.spruceSolid` |

> [!NOTE]
> En la guía el color `#E1E3EA` se llama "Turquoise", pero en realidad es un gris claro. En el código se llama `mist` para que no se confunda.

## Reglas de uso
- **El verde Blue Spruce es el color de acción.** Botones principales: fondo `#197168` y texto blanco (contraste ≈ 6:1, cumple WCAG AA).
- **El coral es acento, no color de error.** Úsalo poco, para dar energía. No lo uses para texto pequeño sobre blanco (contraste ≈ 3:1).
  Para errores y débitos se usa un rojo más profundo (`Theme.negative`, `#D6363B`).
- **Modo oscuro:** fondo Onyx → Jet Black. El color interactivo pasa a Dark Slate Grey (`#ADCBC8`) para que se lea bien. Los botones principales mantienen Blue Spruce.
- **Liquid Glass:** el vidrio se tiñe con Blue Spruce a baja opacidad (0.18–0.35) sobre el fondo blanco → `#E1E3EA`.

## Isotipo
La "C" con la silueta del cuy, en `docs/brand/` (`cuypay-isotipo-spruce|white|onyx.svg` + PNG 1024).
En la app: `CuyPayIsotype` (SwiftUI `Shape`) dentro de `CuyPayLogo`. El ícono de la app usa el isotipo blanco sobre un degradado de Onyx a Blue Spruce.

> [!WARNING]
> **Provisional:** se vectorizó a partir de una captura de baja resolución. Cuando Zarta Studio entregue el SVG oficial, se reemplazan los SVG, la ruta de `CuyPayIsotype.swift` y el ícono.

## Pendiente
- El SVG oficial del isotipo y del logotipo completo.
- La tipografía oficial de la marca, si la guía la define.
