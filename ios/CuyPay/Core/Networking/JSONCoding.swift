import Foundation

/// Codificadores JSON compartidos: camelCase (por defecto en Swift) y fechas ISO-8601 UTC.
enum JSONCoding {
    static func makeDecoder() -> JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            let string = try container.decode(String.self)
            if let date = parseDate(string) {
                return date
            }
            throw DecodingError.dataCorruptedError(
                in: container,
                debugDescription: "Fecha ISO-8601 inválida: \(string)"
            )
        }
        return decoder
    }

    static func makeEncoder() -> JSONEncoder {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .custom { date, encoder in
            var container = encoder.singleValueContainer()
            try container.encode(date.formatted(.iso8601))
        }
        // Orden estable: facilita depurar y que el hash del body sea reproducible en tests.
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return encoder
    }

    /// Acepta `2026-11-07T23:50:10Z`, `2026-11-07T23:50:10.123Z`, offsets y fechas simples `2026-11-07`
    /// (usado en `history` de la tasa).
    static func parseDate(_ string: String) -> Date? {
        if let date = try? Date(string, strategy: Date.ISO8601FormatStyle(includingFractionalSeconds: true)) {
            return date
        }
        if let date = try? Date(string, strategy: Date.ISO8601FormatStyle()) {
            return date
        }
        if let date = try? Date(string, strategy: Date.ISO8601FormatStyle().year().month().day()) {
            return date
        }
        return nil
    }
}
