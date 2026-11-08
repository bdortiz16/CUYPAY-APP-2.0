import SwiftUI

/// Colores y medidas de marca CuyPay.
/// Paleta oficial: "CUYPAY Identity Proposal" — Zarta Studio (ver `docs/BRAND.md`).
enum Theme {
    // MARK: Paleta de marca

    /// Onyx #0C1214 — color principal (fondos oscuros, texto fuerte).
    static let onyx = Color("BrandOnyx")
    /// Jet Black #152830 — superficies oscuras secundarias.
    static let jetBlack = Color("BrandJetBlack")
    /// Blue Spruce #197168 — verde de marca para acciones e interacción.
    /// En modo oscuro el asset sube a Dark Slate Grey para mantener contraste.
    static let spruce = Color("BrandSpruce")
    /// Blue Spruce fijo (#197168) en ambos modos: fondo de botones principales con texto blanco.
    static let spruceSolid = Color(red: 0.098, green: 0.443, blue: 0.408)
    /// Dark Slate Grey #ADCBC8 — aguamarina suave para fondos y detalles.
    static let slate = Color("BrandSlate")
    /// Vibrant Coral #FA6465 — acento de energía (resaltados, "sin fronteras"). Usar con moderación.
    static let coral = Color("BrandCoral")
    /// #E1E3EA ("Turquoise" en la guía) — gris claro para fondos y contraste.
    static let mist = Color("BrandMist")
    /// Texto principal: Onyx en claro / blanco en oscuro.
    static let ink = Color("BrandInk")

    // MARK: Semánticos

    static let positive = Color(red: 0.098, green: 0.549, blue: 0.494)
    /// Rojo de error/débito, más profundo que el coral para no confundirse con el acento.
    static let negative = Color(red: 0.839, green: 0.212, blue: 0.231)
    static let warning = Color(red: 0.95, green: 0.62, blue: 0.13)

    // MARK: Medidas

    static let cardRadius: CGFloat = 28
    static let sheetRadius: CGFloat = 34
    static let horizontalPadding: CGFloat = 16
}

extension ShapeStyle where Self == Color {
    static var cuySpruce: Color { Theme.spruce }
    static var cuyCoral: Color { Theme.coral }
    static var cuyOnyx: Color { Theme.onyx }
    static var cuyInk: Color { Theme.ink }
}
