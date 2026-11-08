import Foundation

/// `GET /limits` → `LimitsSnapshot`. Todos los límites en COP equivalente, periodos en `America/Bogota`.
struct LimitsSnapshot: Codable, Hashable, Sendable {
    var tier: UserTier
    var currency: Currency
    var items: [LimitItem]

    /// Ítem para una operación y periodo dados.
    func item(_ operation: LimitOperation, _ period: LimitPeriod) -> LimitItem? {
        items.first { $0.operation == operation && $0.period == period }
    }

    /// Ítems de una operación ordenados diario → mensual → anual.
    func items(for operation: LimitOperation) -> [LimitItem] {
        items.filter { $0.operation == operation }.sorted { $0.period.sortOrder < $1.period.sortOrder }
    }

    /// Cupo disponible efectivo para una operación: el mínimo restante entre todos sus periodos.
    /// `nil` si la operación no tiene límites configurados.
    func effectiveRemaining(for operation: LimitOperation) -> Money? {
        let remaining = items(for: operation).map(\.remainingMinor)
        guard let minimum = remaining.min() else { return nil }
        return Money(minorUnits: minimum, currency: currency)
    }

    /// Operaciones presentes, en orden de UI: Envíos, Conversiones, Recargas.
    var operations: [LimitOperation] {
        LimitOperation.displayOrder.filter { op in items.contains { $0.operation == op } }
    }

    /// ¿Cabe `amountMinor` en todos los periodos de la operación?
    func allows(_ amountMinor: Int64, for operation: LimitOperation) -> Bool {
        guard let remaining = effectiveRemaining(for: operation) else { return true }
        return amountMinor <= remaining.minorUnits
    }
}

struct LimitItem: Codable, Hashable, Sendable, Identifiable {
    var operation: LimitOperation
    var period: LimitPeriod
    var limitMinor: Int64
    var usedMinor: Int64

    var id: String { "\(operation.rawValue)-\(period.rawValue)" }

    /// Restante, nunca negativo.
    var remainingMinor: Int64 {
        let (value, overflow) = limitMinor.subtractingReportingOverflow(usedMinor)
        if overflow { return 0 }
        return max(0, value)
    }

    /// Progreso de uso 0...1 (para barras). Es UI, no dinero: `Double` está bien aquí.
    var usedFraction: Double {
        guard limitMinor > 0 else { return usedMinor > 0 ? 1 : 0 }
        let fraction = Double(max(0, usedMinor)) / Double(limitMinor)
        return min(1, max(0, fraction))
    }

    var isExhausted: Bool { remainingMinor == 0 }
    /// Uso ≥ 80 %: mostramos la barra en color de advertencia.
    var isNearLimit: Bool { usedFraction >= 0.8 }
}

enum LimitOperation: String, Codable, Hashable, Sendable {
    case transferOut = "transfer_out"
    case conversion
    case depositIn = "deposit_in"
    case unknown

    init(from decoder: any Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = LimitOperation(rawValue: raw) ?? .unknown
    }

    static let displayOrder: [LimitOperation] = [.transferOut, .conversion, .depositIn]

    var title: String {
        switch self {
        case .transferOut: String(localized: "Envíos")
        case .conversion: String(localized: "Conversiones")
        case .depositIn: String(localized: "Recargas")
        case .unknown: String(localized: "Otros")
        }
    }

    var systemImage: String {
        switch self {
        case .transferOut: "arrow.up.right"
        case .conversion: "arrow.left.arrow.right"
        case .depositIn: "arrow.down.left"
        case .unknown: "questionmark"
        }
    }
}

enum LimitPeriod: String, Codable, Hashable, Sendable {
    case daily
    case monthly
    case annual
    case unknown

    init(from decoder: any Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = LimitPeriod(rawValue: raw) ?? .unknown
    }

    var sortOrder: Int {
        switch self {
        case .daily: 0
        case .monthly: 1
        case .annual: 2
        case .unknown: 3
        }
    }

    var title: String {
        switch self {
        case .daily: String(localized: "Diario")
        case .monthly: String(localized: "Mensual")
        case .annual: String(localized: "Anual")
        case .unknown: String(localized: "Otro")
        }
    }
}
