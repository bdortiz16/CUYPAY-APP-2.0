import Foundation

/// Datos sensibles de la tarjeta obtenidos directamente en el dispositivo desde el token efímero del emisor.
/// Nunca transitan ni se almacenan en el backend de CuyPay.
struct CardSensitiveDetails: Equatable, Sendable {
    let rawPan: String
    let formattedPan: String
    let expiry: String
    let cvv: String
}

enum CardSecureDataExtractor {
    /// Obtiene y extrae PAN, fecha de vencimiento y CVC directamente en el cliente usando una sesión efímera sin caché.
    static func fetch(from url: URL, fallbackLastFour: String) async throws -> CardSensitiveDetails {
        if url.path.contains("/look/demo") || url.host == "mock.cuypay.local" {
            let suffix = fallbackLastFour.count == 4 && fallbackLastFour != "0000" ? fallbackLastFour : "4242"
            let raw = "459919007575\(suffix)"
            return CardSensitiveDetails(
                rawPan: raw,
                formattedPan: formatPan(raw),
                expiry: "09/31",
                cvv: "767"
            )
        }

        let config = URLSessionConfiguration.ephemeral
        config.requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        config.urlCache = nil
        config.timeoutIntervalForRequest = 15
        let session = URLSession(configuration: config)

        var request = URLRequest(url: url)
        request.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        request.setValue("text/html,application/xhtml+xml", forHTTPHeaderField: "Accept")

        let (data, response) = try await session.data(for: request)
        if let http = response as? HTTPURLResponse, !(200...299).contains(http.statusCode) {
            throw APIError.server(
                status: http.statusCode,
                code: .providerError,
                message: "No fue posible consultar los datos seguros de tu tarjeta.",
                limit: nil
            )
        }

        let html = String(decoding: data, as: UTF8.self)
        return try parse(html: html)
    }

    /// Extrae PAN, fecha (MM/YY) y código de seguridad desde el HTML SSR de la vista segura del emisor.
    static func parse(html: String) throws -> CardSensitiveDetails {
        let bodyWithoutScripts = replaceRegex(
            in: html,
            pattern: #"<script\b[^>]*>[\s\S]*?</script>"#,
            with: " "
        )

        // 1. PAN (15-19 dígitos)
        let rawPan: String? = {
            if let panBlock = firstCapture(
                in: bodyWithoutScripts,
                pattern: #"<[^>]*\bid\s*=\s*["']pan["'][^>]*>([\s\S]*?)</p>"#
            ) {
                let clean = stripHtml(panBlock).filter(\.isNumber)
                if (15...19).contains(clean.count) { return clean }
            }
            if let grouped = firstCapture(
                in: stripHtml(bodyWithoutScripts),
                pattern: #"\b(\d{4}(?:\s+\d{4}){2,3}\d{0,3})\b"#
            ) {
                let clean = grouped.filter(\.isNumber)
                if (15...19).contains(clean.count) { return clean }
            }
            return nil
        }()

        // 2. Fecha de vencimiento (MM/YY)
        let expiry: String? = {
            if let expBlock = firstCapture(
                in: bodyWithoutScripts,
                pattern: #"<[^>]*\bid\s*=\s*["']expiration-date["'][^>]*>([\s\S]*?)</p>"#
            ) {
                if let normalized = extractExpiry(from: stripHtml(expBlock)) {
                    return normalized
                }
            }
            return extractExpiry(from: stripHtml(bodyWithoutScripts))
        }()

        // 3. CVC / CVV (3-4 dígitos)
        let cvv: String? = {
            if let cvvBlock = firstCapture(
                in: bodyWithoutScripts,
                pattern: #"<[^>]*\bid\s*=\s*["']security-code["'][^>]*>([\s\S]*?)</p>"#
            ) {
                let cleaned = stripHtml(cvvBlock)
                if let digits = firstCapture(in: cleaned, pattern: #"\b(\d{3,4})\b"#) {
                    return digits
                }
            }
            return firstCapture(
                in: stripHtml(bodyWithoutScripts),
                pattern: #"(?:CVV|CVC|C[óo]digo)[^0-9]{0,16}(\d{3,4})\b"#
            )
        }()

        guard let rawPan, let expiry, let cvv else {
            throw APIError.server(
                status: 502,
                code: .providerError,
                message: "No pudimos mostrar los datos seguros de tu tarjeta en este momento. Intenta de nuevo.",
                limit: nil
            )
        }

        return CardSensitiveDetails(
            rawPan: rawPan,
            formattedPan: formatPan(rawPan),
            expiry: expiry,
            cvv: cvv
        )
    }

    static func formatPan(_ digitsOnly: String) -> String {
        let digits = digitsOnly.filter(\.isNumber)
        var groups: [String] = []
        var index = digits.startIndex
        while index < digits.endIndex {
            let end = digits.index(index, offsetBy: 4, limitedBy: digits.endIndex) ?? digits.endIndex
            groups.append(String(digits[index..<end]))
            index = end
        }
        return groups.joined(separator: " ")
    }

    // MARK: - Helpers privados

    private static func extractExpiry(from text: String) -> String? {
        guard let raw = firstCapture(in: text, pattern: #"\b((?:0[1-9]|1[0-2])\s*/\s*(?:\d{4}|\d{2}))\b"#) else {
            return nil
        }
        let parts = raw.split(separator: "/").map { $0.trimmingCharacters(in: .whitespaces) }
        guard parts.count == 2 else { return nil }
        let month = parts[0]
        let year = parts[1].count == 4 ? String(parts[1].suffix(2)) : parts[1]
        return "\(month)/\(year)"
    }

    private static func stripHtml(_ input: String) -> String {
        let withoutComments = replaceRegex(in: input, pattern: #"<!--[\s\S]*?-->"#, with: "")
        let withoutSvg = replaceRegex(in: withoutComments, pattern: #"<svg\b[\s\S]*?</svg>"#, with: " ")
        let withoutTags = replaceRegex(in: withoutSvg, pattern: #"<[^>]+>"#, with: " ")
        return withoutTags
            .replacingOccurrences(of: "&nbsp;", with: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func replaceRegex(in text: String, pattern: String, with replacement: String) -> String {
        guard let regex = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]) else {
            return text
        }
        let range = NSRange(text.startIndex..<text.endIndex, in: text)
        return regex.stringByReplacingMatches(in: text, options: [], range: range, withTemplate: replacement)
    }

    private static func firstCapture(in text: String, pattern: String) -> String? {
        guard let regex = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]) else {
            return nil
        }
        let range = NSRange(text.startIndex..<text.endIndex, in: text)
        guard let match = regex.firstMatch(in: text, options: [], range: range) else {
            return nil
        }
        let captureIndex = match.numberOfRanges > 1 ? 1 : 0
        guard let swiftRange = Range(match.range(at: captureIndex), in: text) else {
            return nil
        }
        return String(text[swiftRange])
    }
}
