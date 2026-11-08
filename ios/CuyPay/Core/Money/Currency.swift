import Foundation

/// Monedas soportadas por CuyPay. Ambas usan 2 decimales en el contrato (`amountMinor` = centavos).
enum Currency: String, Codable, CaseIterable, Identifiable, Hashable, Sendable {
    case cop = "COP"
    case brl = "BRL"

    var id: String { rawValue }

    /// Código ISO 4217.
    var code: String { rawValue }

    /// Número de decimales en unidades menores (contrato: COP y BRL usan 2).
    var minorUnitDigits: Int { 2 }

    /// 10^minorUnitDigits
    var minorUnitsPerMajor: Int64 { 100 }

    var symbol: String {
        switch self {
        case .cop: "$"
        case .brl: "R$"
        }
    }

    var flag: String {
        switch self {
        case .cop: "🇨🇴"
        case .brl: "🇧🇷"
        }
    }

    /// Nombre localizado para UI.
    var displayName: String {
        switch self {
        case .cop: String(localized: "Pesos colombianos")
        case .brl: String(localized: "Reales brasileños")
        }
    }

    /// Para COP ocultamos los centavos cuando son 0; BRL siempre muestra 2 decimales.
    var alwaysShowsFraction: Bool {
        switch self {
        case .cop: false
        case .brl: true
        }
    }
}
