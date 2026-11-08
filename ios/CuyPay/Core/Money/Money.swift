import Foundation

/// Cantidad de dinero en **unidades menores** (centavos) + moneda.
/// Nunca usamos `Double` para dinero: todo el cálculo es en `Int64` con aritmética verificada.
struct Money: Hashable, Sendable, Codable, Comparable {
    var minorUnits: Int64
    var currency: Currency

    init(minorUnits: Int64, currency: Currency) {
        self.minorUnits = minorUnits
        self.currency = currency
    }

    /// Crea un monto a partir de unidades mayores enteras (ej. `Money(major: 150_000, .cop)` = $150.000,00).
    /// Devuelve `nil` si hay desbordamiento.
    init?(major: Int64, currency: Currency) {
        let (value, overflow) = major.multipliedReportingOverflow(by: currency.minorUnitsPerMajor)
        guard !overflow else { return nil }
        self.init(minorUnits: value, currency: currency)
    }

    static func zero(_ currency: Currency) -> Money { Money(minorUnits: 0, currency: currency) }

    var isZero: Bool { minorUnits == 0 }
    var isNegative: Bool { minorUnits < 0 }

    /// Parte entera (unidades mayores) en valor absoluto.
    var majorMagnitude: UInt64 { minorUnits.magnitude / UInt64(currency.minorUnitsPerMajor) }
    /// Centavos en valor absoluto (0...99).
    var fractionMagnitude: UInt64 { minorUnits.magnitude % UInt64(currency.minorUnitsPerMajor) }

    static func < (lhs: Money, rhs: Money) -> Bool {
        precondition(lhs.currency == rhs.currency, "No se pueden comparar monedas distintas")
        return lhs.minorUnits < rhs.minorUnits
    }

    /// Suma verificada; `nil` si las monedas difieren o hay desbordamiento.
    func adding(_ other: Money) -> Money? {
        guard currency == other.currency else { return nil }
        let (value, overflow) = minorUnits.addingReportingOverflow(other.minorUnits)
        return overflow ? nil : Money(minorUnits: value, currency: currency)
    }

    /// Resta verificada; `nil` si las monedas difieren o hay desbordamiento.
    func subtracting(_ other: Money) -> Money? {
        guard currency == other.currency else { return nil }
        let (value, overflow) = minorUnits.subtractingReportingOverflow(other.minorUnits)
        return overflow ? nil : Money(minorUnits: value, currency: currency)
    }

    var negated: Money { Money(minorUnits: minorUnits == .min ? .max : -minorUnits, currency: currency) }
}

// MARK: - Formateo

extension Money {
    enum SignDisplay: Sendable {
        /// "-$ 1.000" solo si es negativo.
        case automatic
        /// "+$ 1.000" / "-$ 1.000" (útil en listas de transacciones).
        case always
        /// Nunca muestra signo (valor absoluto).
        case never
    }

    /// Formatea el monto de forma determinística (independiente del locale del dispositivo):
    /// - COP: `$ 1.250.000` (es_CO; centavos solo si ≠ 0 → `$ 1.250.000,50`)
    /// - BRL: `R$ 1.823,00` (pt_BR; siempre 2 decimales)
    func formatted(sign: SignDisplay = .automatic, includeSymbol: Bool = true) -> String {
        let integerPart = Money.groupThousands(majorMagnitude, separator: ".")
        var body = integerPart
        let fraction = fractionMagnitude
        if currency.alwaysShowsFraction || fraction != 0 {
            body += "," + (fraction < 10 ? "0\(fraction)" : "\(fraction)")
        }
        if includeSymbol {
            body = currency.symbol + " " + body
        }
        switch sign {
        case .never:
            return body
        case .automatic:
            return minorUnits < 0 ? "-" + body : body
        case .always:
            if minorUnits < 0 { return "-" + body }
            if minorUnits > 0 { return "+" + body }
            return body
        }
    }

    /// Versión "oculta" para cuando el usuario activa el modo privado (ojo tachado).
    var maskedString: String { currency.symbol + " ••••••" }

    /// Agrupa miles con el separador dado: 1250000 → "1.250.000".
    static func groupThousands(_ value: UInt64, separator: String) -> String {
        let digits = String(value)
        guard digits.count > 3 else { return digits }
        var result = ""
        result.reserveCapacity(digits.count + digits.count / 3)
        for (index, character) in digits.enumerated() {
            if index > 0 && (digits.count - index) % 3 == 0 {
                result += separator
            }
            result.append(character)
        }
        return result
    }
}

extension Money: CustomStringConvertible {
    var description: String { formatted() }
}

// MARK: - Parseo seguro (sin Double)

extension Money {
    /// Convierte texto en formato es-CO / pt-BR a `Money` sin pasar por `Double`.
    /// Acepta: `"1.250.000"`, `"1.250.000,5"`, `"$ 1.250.000,50"`, `"R$ 1.823,00"`, `"-20.000"`.
    /// Regla: `.` es separador de miles y `,` el separador decimal (máx. 2 decimales).
    static func parse(_ text: String, currency: Currency) -> Money? {
        var cleaned = text
            .replacingOccurrences(of: currency.symbol, with: "")
            .replacingOccurrences(of: "\u{00A0}", with: "")
            .replacingOccurrences(of: "\u{202F}", with: "")
            .replacingOccurrences(of: " ", with: "")
            .replacingOccurrences(of: ".", with: "")
        guard !cleaned.isEmpty else { return nil }

        var negative = false
        if cleaned.hasPrefix("-") {
            negative = true
            cleaned.removeFirst()
        } else if cleaned.hasPrefix("+") {
            cleaned.removeFirst()
        }

        let parts = cleaned.split(separator: ",", omittingEmptySubsequences: false)
        guard parts.count == 1 || parts.count == 2 else { return nil }

        let integerString = String(parts[0])
        let fractionString = parts.count == 2 ? String(parts[1]) : ""
        guard !integerString.isEmpty || !fractionString.isEmpty else { return nil }
        guard integerString.allSatisfy(\.isASCIIDigit), fractionString.allSatisfy(\.isASCIIDigit) else { return nil }
        guard fractionString.count <= currency.minorUnitDigits else { return nil }

        let major = integerString.isEmpty ? 0 : Int64(integerString)
        guard let major else { return nil }

        var fraction: Int64 = 0
        if !fractionString.isEmpty {
            let padded = fractionString.padding(toLength: currency.minorUnitDigits, withPad: "0", startingAt: 0)
            guard let value = Int64(padded) else { return nil }
            fraction = value
        }

        let (scaled, overflow1) = major.multipliedReportingOverflow(by: currency.minorUnitsPerMajor)
        guard !overflow1 else { return nil }
        let (total, overflow2) = scaled.addingReportingOverflow(fraction)
        guard !overflow2 else { return nil }
        return Money(minorUnits: negative ? -total : total, currency: currency)
    }
}

extension Character {
    /// Solo dígitos ASCII 0-9 (evita dígitos arábigos, superíndices, etc.).
    var isASCIIDigit: Bool {
        guard let ascii = asciiValue else { return false }
        return ascii >= 48 && ascii <= 57
    }
}
