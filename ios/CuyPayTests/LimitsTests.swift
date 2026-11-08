import Foundation
import Testing
@testable import CuyPay

@Suite("Límites — cálculos")
struct LimitsTests {
    static let contractSample = """
    { "tier": "full", "currency": "COP", "items": [
      { "operation": "transfer_out", "period": "daily",   "limitMinor": 300000000,  "usedMinor": 5000000 },
      { "operation": "transfer_out", "period": "monthly", "limitMinor": 2000000000, "usedMinor": 5000000 },
      { "operation": "transfer_out", "period": "annual",  "limitMinor": 15000000000,"usedMinor": 5000000 },
      { "operation": "conversion",   "period": "daily",   "limitMinor": 200000000,  "usedMinor": 0 },
      { "operation": "deposit_in",   "period": "monthly", "limitMinor": 2000000000, "usedMinor": 0 }
    ] }
    """

    private func sample() throws -> LimitsSnapshot {
        try JSONCoding.makeDecoder().decode(LimitsSnapshot.self, from: Data(Self.contractSample.utf8))
    }

    @Test("Restante nunca negativo")
    func remainingClamp() {
        let over = LimitItem(operation: .transferOut, period: .daily, limitMinor: 100, usedMinor: 150)
        #expect(over.remainingMinor == 0)
        #expect(over.isExhausted)
        #expect(over.usedFraction == 1)
        let normal = LimitItem(operation: .transferOut, period: .daily, limitMinor: 100, usedMinor: 25)
        #expect(normal.remainingMinor == 75)
        #expect(normal.usedFraction == 0.25)
        #expect(!normal.isNearLimit)
        #expect(LimitItem(operation: .conversion, period: .daily, limitMinor: 100, usedMinor: 80).isNearLimit)
    }

    @Test("Límite cero")
    func zeroLimit() {
        #expect(LimitItem(operation: .conversion, period: .daily, limitMinor: 0, usedMinor: 0).usedFraction == 0)
        #expect(LimitItem(operation: .conversion, period: .daily, limitMinor: 0, usedMinor: 1).usedFraction == 1)
    }

    @Test("Cupo efectivo = mínimo entre periodos")
    func effectiveRemaining() throws {
        var snapshot = try sample()
        #expect(snapshot.effectiveRemaining(for: .transferOut)?.minorUnits == 295_000_000)
        // Si el mensual está casi agotado, manda el mensual.
        snapshot.items[1].usedMinor = 1_990_000_000
        #expect(snapshot.effectiveRemaining(for: .transferOut)?.minorUnits == 10_000_000)
        #expect(snapshot.effectiveRemaining(for: .unknown) == nil)
    }

    @Test("allows(_:for:) respeta todos los periodos")
    func allows() throws {
        let snapshot = try sample()
        #expect(snapshot.allows(295_000_000, for: .transferOut))
        #expect(!snapshot.allows(295_000_001, for: .transferOut))
        #expect(snapshot.allows(200_000_000, for: .conversion))
        #expect(!snapshot.allows(200_000_001, for: .conversion))
        // Operación sin límites configurados → permitida (el backend decide).
        #expect(snapshot.allows(.max, for: .unknown))
    }

    @Test("Orden de operaciones y periodos para la UI")
    func ordering() throws {
        let snapshot = try sample()
        #expect(snapshot.operations == [.transferOut, .conversion, .depositIn])
        #expect(snapshot.items(for: .transferOut).map(\.period) == [.daily, .monthly, .annual])
    }
}

@Suite("Detección de tipo de llave Bre-B")
struct BrebKeyKindTests {
    @Test("Tipos", arguments: [
        ("3001234567", BrebKeyKind.phone),
        ("1020304050", .nationalId),
        ("52123456", .nationalId),
        ("juan@correo.com", .email),
        ("@juanp", .alias),
        ("JUAN123", .alphanumeric),
        ("ab", .invalid),
        ("@", .invalid),
        ("juan@", .invalid),
        ("12", .invalid),
    ])
    func detect(raw: String, expected: BrebKeyKind) {
        #expect(BrebKeyKind.detect(raw) == expected)
    }
}

@Suite("Agrupación por día")
struct DayGroupingTests {
    @Test("Agrupa y ordena del más reciente al más antiguo")
    func sections() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "America/Bogota")!
        let now = Date(timeIntervalSince1970: 1_794_095_410) // 2026-11-07 18:50 Bogotá
        func transaction(_ id: String, hoursAgo: Double) -> WalletTransaction {
            var tx = WalletTransaction.placeholder
            tx.id = id
            tx.createdAt = now.addingTimeInterval(-hoursAgo * 3600)
            return tx
        }
        let items = [transaction("a", hoursAgo: 1), transaction("b", hoursAgo: 30), transaction("c", hoursAgo: 2)]
        let sections = DayGrouping.sections(for: items, now: now, calendar: calendar)
        #expect(sections.count == 2)
        #expect(sections.first?.items.map(\.id) == ["a", "c"])
        #expect(sections.last?.items.map(\.id) == ["b"])
    }
}
