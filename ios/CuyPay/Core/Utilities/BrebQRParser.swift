import Foundation

struct EmvTLVEntry: Equatable, Sendable {
    let tag: String
    let value: String
}

enum BrebQRInitiationMethod: String, Equatable, Sendable {
    case staticQR = "static"
    case dynamicQR = "dynamic"
}

struct ParsedBrebQR: Equatable, Sendable {
    let rawPayload: String
    let isEmvCo: Bool
    let crcValid: Bool?
    let initiationMethod: BrebQRInitiationMethod?
    let primaryKey: String
    let candidateKeys: [String]
    let isMerchant: Bool
    let merchantName: String?
    let merchantCity: String?
    let currencyCode: String
    let amountMinor: Int64?
    let reference: String?
}

enum BrebQRParseResult: Equatable, Sendable {
    case valid(ParsedBrebQR)
    case unsupportedQR(reason: String)
}

/// Decodificador de códigos QR interoperables Bre-B / EMVCo Colombia (Estándar EASPBV v1.5 — ACH / Redeban / Credibanco / Banrep).
enum BrebQRParser {
    enum KeyHint: Sendable {
        case id
        case phone
        case email
        case alias
        case merchant
        case auto
    }

    private static let nonKeyGuiSuffixes: [String] = [
        ".red", ".ca", ".sec", ".canal", ".civa", ".iva", ".base", ".cinc", ".inc", ".trxid", ".desc",
    ]

    private static let knownNetworkCodes: Set<String> = [
        "ACH", "BRC", "CRB", "RBM", "SVB", "VISI", "GOU", "MCCA", "VCSS",
    ]

    /// Calcula el CRC-16/CCITT-FALSE (polinomio `0x1021`, valor inicial `0xFFFF`) sobre UTF-8.
    static func computeEmvCRC16(_ payloadUpTo6304: String) -> String {
        var crc: UInt16 = 0xFFFF
        for byte in payloadUpTo6304.utf8 {
            crc ^= UInt16(byte) << 8
            for _ in 0..<8 {
                if (crc & 0x8000) != 0 {
                    crc = (crc << 1) ^ 0x1021
                } else {
                    crc <<= 1
                }
            }
        }
        return String(format: "%04X", crc)
    }

    /// Parsea una secuencia TLV EMVCo (`[tag:2][len:2][value:len]`) sobre escalares Unicode.
    static func parseEmvTLVs(_ input: String) -> [EmvTLVEntry]? {
        let scalars = Array(input.unicodeScalars)
        var entries: [EmvTLVEntry] = []
        var idx = 0

        while idx < scalars.count {
            if idx + 4 > scalars.count {
                return entries.isEmpty ? nil : entries
            }
            let tag = String(String.UnicodeScalarView(scalars[idx..<(idx + 2)]))
            let lenStr = String(String.UnicodeScalarView(scalars[(idx + 2)..<(idx + 4)]))
            let validTag = tag.unicodeScalars.allSatisfy { CharacterSet.alphanumerics.contains($0) && $0.isASCII }
            let validLen = lenStr.unicodeScalars.allSatisfy { $0.value >= 48 && $0.value <= 57 }
            guard validTag, validLen, let len = Int(lenStr) else {
                return entries.isEmpty ? nil : entries
            }
            idx += 4
            if len == 0 {
                entries.append(EmvTLVEntry(tag: tag, value: ""))
                continue
            }
            if idx + len > scalars.count {
                return entries.isEmpty ? nil : entries
            }
            let value = String(String.UnicodeScalarView(scalars[idx..<(idx + len)]))
            entries.append(EmvTLVEntry(tag: tag, value: value))
            idx += len
            if tag == "63" { break }
        }

        return entries.isEmpty ? nil : entries
    }

    /// Normaliza una llave candidata según su naturaleza (celular, alias `@`, correo, código de comercio o documento).
    static func normalizeKeyCandidate(_ raw: String, hint: KeyHint = .auto) -> String? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed.count <= 128 else { return nil }
        if trimmed.contains("://") { return nil }

        if hint == .email || (!trimmed.hasPrefix("@") && trimmed.contains("@")) {
            let email = trimmed.lowercased().replacingOccurrences(of: " ", with: "")
            let parts = email.split(separator: "@", omittingEmptySubsequences: false)
            if parts.count == 2, !parts[0].isEmpty, !parts[1].isEmpty,
               parts[1].contains("."), !parts[1].hasSuffix(".") {
                return email
            }
            return nil
        }

        if hint == .alias || trimmed.hasPrefix("@") {
            let clean = String(trimmed.drop(while: { $0 == "@" })).trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            guard !clean.isEmpty, clean.count <= 63 else { return nil }
            let valid = clean.allSatisfy { ch in
                ch.isASCII && (ch.isLetter || ch.isNumber || ch == "." || ch == "_" || ch == "-")
            }
            return valid ? "@\(clean)" : nil
        }

        if hint == .phone {
            let digits = String(trimmed.filter(\.isASCIIDigit))
            if digits.count == 12 && digits.hasPrefix("573") {
                return String(digits.dropFirst(2))
            }
            if (10...15).contains(digits.count) {
                return digits
            }
            return nil
        }

        if hint == .merchant {
            let cleaned = trimmed
                .replacingOccurrences(of: " ", with: "")
                .replacingOccurrences(of: "-", with: "")
            if (5...15).contains(cleaned.count) && cleaned.allSatisfy(\.isASCIIDigit) {
                return cleaned
            }
            if (4...40).contains(cleaned.count) && cleaned.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "." || $0 == "_" || $0 == "-") }) {
                return cleaned
            }
            return nil
        }

        if hint == .id {
            let cleaned = trimmed
                .replacingOccurrences(of: " ", with: "")
                .replacingOccurrences(of: ".", with: "")
                .replacingOccurrences(of: "-", with: "")
            if (5...15).contains(cleaned.count) && cleaned.allSatisfy(\.isASCIIDigit) {
                return cleaned
            }
            if (5...20).contains(cleaned.count) && cleaned.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber) }) {
                return cleaned.uppercased()
            }
            return nil
        }

        // Modo automático (`auto`)
        let compactPhone = trimmed
            .replacingOccurrences(of: " ", with: "")
            .replacingOccurrences(of: "(", with: "")
            .replacingOccurrences(of: ")", with: "")
            .replacingOccurrences(of: "-", with: "")
        if compactPhone.hasPrefix("+573") && compactPhone.count == 13 && compactPhone.dropFirst().allSatisfy(\.isASCIIDigit) {
            return String(compactPhone.dropFirst(3))
        }
        if compactPhone.hasPrefix("573") && compactPhone.count == 12 && compactPhone.allSatisfy(\.isASCIIDigit) {
            return String(compactPhone.dropFirst(2))
        }
        if compactPhone.hasPrefix("+") && (11...16).contains(compactPhone.count) && compactPhone.dropFirst().allSatisfy(\.isASCIIDigit) {
            return String(compactPhone.dropFirst())
        }

        let compactDigits = trimmed
            .replacingOccurrences(of: " ", with: "")
            .replacingOccurrences(of: "-", with: "")
        if (5...15).contains(compactDigits.count) && compactDigits.allSatisfy(\.isASCIIDigit) {
            if compactDigits.count == 12 && compactDigits.hasPrefix("573") {
                return String(compactDigits.dropFirst(2))
            }
            return compactDigits
        }

        if (3...63).contains(trimmed.count) && trimmed.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "." || $0 == "_" || $0 == "-") }) {
            return trimmed
        }

        return nil
    }

    static func parse(_ rawInput: String) -> BrebQRParseResult {
        let trimmed = rawInput.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            return .unsupportedQR(reason: "El código QR está vacío.")
        }

        // 1. Detectar EMVCo Merchant-Presented Mode (`00` + longitud + `01`/`02`)
        if isLikelyEmvCoHeader(trimmed), let tlvs = parseEmvTLVs(trimmed), tlvs.contains(where: { $0.tag == "00" }) {
            return parseEmvPayload(trimmed, tlvs: tlvs)
        }

        // 2. Detectar URLs / esquemas (`https://`, `cuypay://`, `breb://`, `mailto:`, `tel:`, `WIFI:`, etc.)
        if hasURIScheme(trimmed) {
            let lower = trimmed.lowercased()
            if lower.hasPrefix("wifi:") || lower.hasPrefix("begin:") || lower.hasPrefix("smsto:") || lower.hasPrefix("geo:") || lower.hasPrefix("matmsg:") {
                return .unsupportedQR(reason: "Este código QR no corresponde a un pago o llave Bre-B.")
            }
            if let fromURL = extractFromURL(trimmed) {
                return fromURL
            }
        }

        // 3. Llave directa en texto plano
        guard let direct = normalizeKeyCandidate(trimmed, hint: .auto) else {
            return .unsupportedQR(reason: "Llave Bre-B o código QR no válido.")
        }

        var candidates: [String] = [direct]
        let isTenDigitMerchant = direct.count == 10 && direct.allSatisfy(\.isASCIIDigit) && direct.hasPrefix("00")
        if !isTenDigitMerchant && !direct.hasPrefix("@") && !direct.contains("@") && direct.contains(where: \.isLetter) {
            let withAt = "@\(direct.lowercased())"
            if !candidates.contains(withAt) {
                candidates.insert(withAt, at: 0)
            }
        }

        return .valid(
            ParsedBrebQR(
                rawPayload: trimmed,
                isEmvCo: false,
                crcValid: nil,
                initiationMethod: nil,
                primaryKey: candidates[0],
                candidateKeys: candidates,
                isMerchant: isTenDigitMerchant,
                merchantName: nil,
                merchantCity: nil,
                currencyCode: "COP",
                amountMinor: nil,
                reference: nil
            )
        )
    }

    // MARK: - Internals

    private static func isLikelyEmvCoHeader(_ s: String) -> Bool {
        guard s.count >= 6, s.hasPrefix("00") else { return false }
        let chars = Array(s.prefix(6))
        return chars[2].isASCIIDigit && chars[3].isASCIIDigit && chars[4] == "0" && (chars[5] == "1" || chars[5] == "2")
    }

    private static func hasURIScheme(_ s: String) -> Bool {
        guard let colonIdx = s.firstIndex(of: ":") else { return false }
        let scheme = s[..<colonIdx]
        guard let first = scheme.first, first.isASCII && first.isLetter else { return false }
        return scheme.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "+" || $0 == "." || $0 == "-") }
    }

    private static func parseEmvPayload(_ trimmed: String, tlvs: [EmvTLVEntry]) -> BrebQRParseResult {
        var map: [String: String] = [:]
        for entry in tlvs where map[entry.tag] == nil {
            map[entry.tag] = entry.value
        }

        var crcValid: Bool? = nil
        if trimmed.count > 8 {
            let suffix8 = String(trimmed.suffix(8))
            if suffix8.prefix(4) == "6304" {
                let crcHex = String(suffix8.suffix(4))
                if crcHex.allSatisfy(\.isHexDigit) {
                    let prefixUpTo6304 = String(trimmed.dropLast(4))
                    crcValid = computeEmvCRC16(prefixUpTo6304) == crcHex.uppercased()
                }
            }
        }

        let initiationMethod: BrebQRInitiationMethod? = switch map["01"] {
        case "11": .staticQR
        case "12": .dynamicQR
        default: nil
        }

        var candidates: [String] = []
        func pushCandidate(_ key: String?) {
            guard let key, !key.isEmpty, !candidates.contains(key) else { return }
            candidates.append(key)
        }

        var hasMerchantCode = false
        var templates: [(tagNum: Int, gui: String, subs: [EmvTLVEntry])] = []
        for entry in tlvs {
            if let tagNum = Int(entry.tag), (26...51).contains(tagNum), let subs = parseEmvTLVs(entry.value), !subs.isEmpty {
                let gui = (subs.first(where: { $0.tag == "00" })?.value ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
                templates.append((tagNum, gui, subs))
            }
        }

        func extractMultillaveSubs(_ subs: [EmvTLVEntry], gui: String) {
            for sub in subs {
                guard sub.tag != "00" else { continue }
                let val = sub.value.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !val.isEmpty else { continue }

                if val.lowercased().hasPrefix("http://") || val.lowercased().hasPrefix("https://") {
                    if case .valid(let fromURL) = extractFromURL(val) {
                        for k in fromURL.candidateKeys { pushCandidate(k) }
                    }
                    continue
                }

                if knownNetworkCodes.contains(val.uppercased()) { continue }

                let isColombianLla = gui.hasSuffix(".lla") || gui.contains("breb") || gui.contains("bre-b") || gui.contains("banrep")
                if isColombianLla {
                    switch sub.tag {
                    case "01":
                        pushCandidate(normalizeKeyCandidate(val, hint: .id))
                    case "02":
                        pushCandidate(normalizeKeyCandidate(val, hint: .phone))
                    case "03":
                        pushCandidate(normalizeKeyCandidate(val, hint: .email))
                    case "04":
                        pushCandidate(normalizeKeyCandidate(val, hint: .alias))
                        if !val.hasPrefix("@") {
                            pushCandidate(normalizeKeyCandidate(val, hint: .auto))
                        }
                    case "05":
                        hasMerchantCode = true
                        let mKey = normalizeKeyCandidate(val, hint: .merchant)
                        pushCandidate(mKey)
                        if let mKey, (6...9).contains(mKey.count), mKey.allSatisfy(\.isASCIIDigit) {
                            pushCandidate(String(repeating: "0", count: 10 - mKey.count) + mKey)
                        }
                    default:
                        pushCandidate(normalizeKeyCandidate(val, hint: .auto))
                    }
                } else if let auto = normalizeKeyCandidate(val, hint: .auto) {
                    if !auto.hasPrefix("@") && !auto.contains("@") && auto.contains(where: \.isLetter) {
                        pushCandidate("@\(auto.lowercased())")
                    }
                    pushCandidate(auto)
                }
            }
        }

        // Prioridad 1: Templates explícitos de llave Bre-B (`*.lla`, `breb`, `banrep`) o Tag 26 estándar
        for tpl in templates {
            let isExplicitKeyGui =
                tpl.gui.hasSuffix(".lla") ||
                tpl.gui.contains("breb") ||
                tpl.gui.contains("bre-b") ||
                tpl.gui.contains("banrep") ||
                tpl.gui.contains("alias") ||
                tpl.gui.contains("llave")
            let isNonKey = nonKeyGuiSuffixes.contains(where: { tpl.gui.hasSuffix($0) }) || tpl.gui.hasSuffix(".cu")
            if isExplicitKeyGui || (tpl.tagNum == 26 && !isNonKey) {
                extractMultillaveSubs(tpl.subs, gui: tpl.gui)
            }
        }

        // Prioridad 2: Código Único del Comercio en Tag 50 o GUI `*.cu`
        for tpl in templates where tpl.tagNum == 50 || tpl.gui.hasSuffix(".cu") {
            for sub in tpl.subs where sub.tag != "00" {
                let rawCu = sub.value.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !rawCu.isEmpty, let cu = normalizeKeyCandidate(rawCu, hint: .merchant) else { continue }
                hasMerchantCode = true
                pushCandidate(cu)
                if (6...9).contains(cu.count) && cu.allSatisfy(\.isASCIIDigit) {
                    pushCandidate(String(repeating: "0", count: 10 - cu.count) + cu)
                }
            }
        }

        // Prioridad 3: Otros templates en 27..48 que no sean redes (.red) ni agregadores (.ca)
        for tpl in templates where (27...48).contains(tpl.tagNum) {
            let isNonKey = nonKeyGuiSuffixes.contains(where: { tpl.gui.hasSuffix($0) }) || tpl.gui.hasSuffix(".cu")
            if !isNonKey {
                extractMultillaveSubs(tpl.subs, gui: tpl.gui)
            }
        }

        let additionalSubs = map["62"].flatMap(parseEmvTLVs) ?? []
        let langSubs = map["64"].flatMap(parseEmvTLVs) ?? []

        // Prioridad 4: Respaldo desde Tag 62 (`02` celular, `10` NIT comercio)
        if let mobile62 = additionalSubs.first(where: { $0.tag == "02" })?.value {
            pushCandidate(normalizeKeyCandidate(mobile62, hint: .phone))
        }
        let nit62 = additionalSubs.first(where: { $0.tag == "10" })?.value
        if let nit62 {
            hasMerchantCode = true
            let cleanNit = String(nit62.filter(\.isASCIIDigit))
            if (5...15).contains(cleanNit.count) {
                pushCandidate(cleanNit)
                if cleanNit.count == 10 && (cleanNit.hasPrefix("8") || cleanNit.hasPrefix("9")) {
                    pushCandidate(String(cleanNit.prefix(9)))
                }
            }
        }

        guard let primaryKey = candidates.first else {
            return .unsupportedQR(
                reason: "Este código QR no contiene una llave Bre-B interoperable. Solicita al comercio o destinatario su QR o llave Bre-B."
            )
        }

        let mcc = cleanEmvText(map["52"])
        let isMerchant = hasMerchantCode || nit62 != nil || (mcc != nil && mcc != "0000" && mcc != "4829")
        let merchantName = cleanEmvText(langSubs.first(where: { $0.tag == "01" })?.value) ?? cleanEmvText(map["59"])
        let merchantCity = cleanEmvText(langSubs.first(where: { $0.tag == "02" })?.value) ?? cleanEmvText(map["60"])

        let rawCurrency = map["53"]?.trimmingCharacters(in: .whitespacesAndNewlines)
        let currencyCode: String = switch rawCurrency {
        case nil, "", "170": "COP"
        case "986": "BRL"
        case let other?: other
        }
        let amountMinor = currencyCode == "COP" ? parseMajorAmountToCopMinor(map["54"]) : nil

        let billing = cleanEmvText(additionalSubs.first(where: { $0.tag == "01" })?.value)
        let refLabel = cleanEmvText(additionalSubs.first(where: { $0.tag == "05" })?.value)
        let reference = billing ?? refLabel

        return .valid(
            ParsedBrebQR(
                rawPayload: trimmed,
                isEmvCo: true,
                crcValid: crcValid,
                initiationMethod: initiationMethod,
                primaryKey: primaryKey,
                candidateKeys: candidates,
                isMerchant: isMerchant,
                merchantName: merchantName,
                merchantCity: merchantCity,
                currencyCode: currencyCode,
                amountMinor: amountMinor,
                reference: reference
            )
        )
    }

    private static func extractFromURL(_ raw: String) -> BrebQRParseResult? {
        guard let components = URLComponents(string: raw), let scheme = components.scheme?.lowercased() else {
            return nil
        }

        if scheme == "mailto" {
            guard let email = normalizeKeyCandidate(components.path, hint: .email) else {
                return .unsupportedQR(reason: "El código QR no contiene un correo válido para Bre-B.")
            }
            return .valid(
                ParsedBrebQR(
                    rawPayload: raw,
                    isEmvCo: false,
                    crcValid: nil,
                    initiationMethod: nil,
                    primaryKey: email,
                    candidateKeys: [email],
                    isMerchant: false,
                    merchantName: nil,
                    merchantCity: nil,
                    currencyCode: "COP",
                    amountMinor: nil,
                    reference: nil
                )
            )
        }

        if scheme == "tel" {
            guard let phone = normalizeKeyCandidate(components.path, hint: .phone) else {
                return .unsupportedQR(reason: "El código QR no contiene un celular válido para Bre-B.")
            }
            return .valid(
                ParsedBrebQR(
                    rawPayload: raw,
                    isEmvCo: false,
                    crcValid: nil,
                    initiationMethod: nil,
                    primaryKey: phone,
                    candidateKeys: [phone],
                    isMerchant: false,
                    merchantName: nil,
                    merchantCity: nil,
                    currencyCode: "COP",
                    amountMinor: nil,
                    reference: nil
                )
            )
        }

        let queryItems = components.queryItems ?? []
        func queryValue(_ names: [String]) -> String? {
            for name in names {
                if let val = queryItems.first(where: { $0.name.caseInsensitiveCompare(name) == .orderedSame })?.value,
                   !val.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    return val.trimmingCharacters(in: .whitespacesAndNewlines)
                }
            }
            return nil
        }

        if let nested = queryValue(["qr", "emv", "payload", "data", "code"]), nested.hasPrefix("0002") {
            return parse(nested)
        }

        var candidates: [String] = []
        func pushCandidate(_ key: String?) {
            guard let key, !key.isEmpty, !candidates.contains(key) else { return }
            candidates.append(key)
        }

        let paramHints: [(String, KeyHint)] = [
            ("key", .auto), ("alias", .alias), ("llave", .auto), ("breb", .auto),
            ("to", .auto), ("recipient", .auto), ("phone", .phone), ("celular", .phone),
            ("merchant", .merchant), ("comercio", .merchant),
        ]
        for (name, hint) in paramHints {
            if let val = queryValue([name]) {
                let normalized = normalizeKeyCandidate(val, hint: hint)
                if let normalized, hint == .auto, !normalized.hasPrefix("@"), !normalized.contains("@"), normalized.contains(where: \.isLetter) {
                    pushCandidate("@\(normalized.lowercased())")
                }
                pushCandidate(normalized)
            }
        }

        let segments = components.path
            .split(separator: "/")
            .map { String($0).trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        for seg in segments.reversed() {
            if seg.hasPrefix("@") {
                pushCandidate(normalizeKeyCandidate(seg, hint: .alias))
            } else if (scheme == "cuypay" || scheme == "breb") && seg.lowercased() != "pay" && seg.lowercased() != "send" {
                pushCandidate(normalizeKeyCandidate(seg, hint: .auto))
            }
        }

        if (scheme == "cuypay" || scheme == "breb"),
           let host = components.host, !host.isEmpty,
           host.lowercased() != "pay", host.lowercased() != "send" {
            pushCandidate(normalizeKeyCandidate(host, hint: .auto))
        }

        guard let primaryKey = candidates.first else {
            return .unsupportedQR(reason: "Este código QR contiene un enlace web que no incluye una llave Bre-B.")
        }

        let amountMinor = parseMajorAmountToCopMinor(queryValue(["amount", "monto", "valor"]))
        let reference = cleanEmvText(queryValue(["ref", "reference", "referencia"]))
        let merchantName = cleanEmvText(queryValue(["name", "nombre"]))
        let isMerchant = queryValue(["merchant", "comercio"]) != nil

        return .valid(
            ParsedBrebQR(
                rawPayload: raw,
                isEmvCo: false,
                crcValid: nil,
                initiationMethod: amountMinor != nil ? .dynamicQR : nil,
                primaryKey: primaryKey,
                candidateKeys: candidates,
                isMerchant: isMerchant,
                merchantName: merchantName,
                merchantCity: nil,
                currencyCode: "COP",
                amountMinor: amountMinor,
                reference: reference
            )
        )
    }

    private static func parseMajorAmountToCopMinor(_ rawAmount: String?) -> Int64? {
        guard let rawAmount else { return nil }
        let cleaned = rawAmount.trimmingCharacters(in: .whitespacesAndNewlines).replacingOccurrences(of: ",", with: ".")
        guard !cleaned.isEmpty else { return nil }
        let parts = cleaned.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count <= 2, !parts[0].isEmpty, parts[0].allSatisfy(\.isASCIIDigit) else { return nil }
        let fracStr: String
        if parts.count == 2 {
            guard (1...2).contains(parts[1].count), parts[1].allSatisfy(\.isASCIIDigit) else { return nil }
            fracStr = parts[1].count == 1 ? "\(parts[1])0" : String(parts[1])
        } else {
            fracStr = "00"
        }
        guard let major = Int64(parts[0]), let cents = Int64(fracStr) else { return nil }
        let (scaled, o1) = major.multipliedReportingOverflow(by: 100)
        let (minor, o2) = scaled.addingReportingOverflow(cents)
        guard !o1, !o2, minor > 0 else { return nil }
        return minor
    }

    private static func cleanEmvText(_ raw: String?) -> String? {
        guard let raw else { return nil }
        let collapsed = raw
            .components(separatedBy: .whitespacesAndNewlines)
            .filter { !$0.isEmpty }
            .joined(separator: " ")
        guard !collapsed.isEmpty else { return nil }
        let upper = collapsed.uppercased()
        if upper == "NA" || upper == "N/A" || upper == "***" || upper == "*" || upper.allSatisfy({ $0 == "0" }) {
            return nil
        }
        return collapsed
    }
}
