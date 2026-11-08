import SwiftUI

/// Colores y medidas de marca CuyPay.
enum Theme {
    /// Navy de marca (#0D1B24).
    static let navy = Color("BrandNavy")
    /// Mint/teal de acento (#2ED3B7).
    static let mint = Color("BrandMint")
    /// Texto principal sobre fondos claros (#0F2430) / claro en modo oscuro.
    static let ink = Color("BrandInk")

    static let positive = Color(red: 0.12, green: 0.66, blue: 0.42)
    static let negative = Color(red: 0.89, green: 0.27, blue: 0.27)
    static let warning = Color(red: 0.95, green: 0.62, blue: 0.13)

    static let cardRadius: CGFloat = 28
    static let sheetRadius: CGFloat = 34
    static let horizontalPadding: CGFloat = 16
}

extension ShapeStyle where Self == Color {
    static var cuyMint: Color { Theme.mint }
    static var cuyNavy: Color { Theme.navy }
    static var cuyInk: Color { Theme.ink }
}
