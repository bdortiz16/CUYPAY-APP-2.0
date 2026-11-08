import Foundation

/// Agrupa transacciones por día: "Hoy", "Ayer" o "5 de noviembre".
enum DayGrouping {
    struct Section<Item: Identifiable>: Identifiable {
        let day: Date
        let title: String
        let items: [Item]
        var id: Date { day }
    }

    static func title(for day: Date, now: Date = Date(), calendar: Calendar = .current, locale: Locale = Locale(identifier: "es_CO")) -> String {
        if calendar.isDate(day, inSameDayAs: now) {
            return String(localized: "Hoy")
        }
        if let yesterday = calendar.date(byAdding: .day, value: -1, to: now), calendar.isDate(day, inSameDayAs: yesterday) {
            return String(localized: "Ayer")
        }
        let sameYear = calendar.component(.year, from: day) == calendar.component(.year, from: now)
        var style = Date.FormatStyle(locale: locale, calendar: calendar, timeZone: calendar.timeZone)
            .day()
            .month(.wide)
        if !sameYear {
            style = style.year()
        }
        return day.formatted(style)
    }

    static func sections(for transactions: [WalletTransaction], now: Date = Date(), calendar: Calendar = .current) -> [Section<WalletTransaction>] {
        let grouped = Dictionary(grouping: transactions) { calendar.startOfDay(for: $0.createdAt) }
        return grouped.keys.sorted(by: >).map { day in
            Section(
                day: day,
                title: title(for: day, now: now, calendar: calendar),
                items: (grouped[day] ?? []).sorted { $0.createdAt > $1.createdAt }
            )
        }
    }
}
