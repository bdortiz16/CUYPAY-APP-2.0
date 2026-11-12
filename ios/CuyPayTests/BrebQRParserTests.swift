import Foundation
import Testing
@testable import CuyPay

@Suite("Decodificación QR Bre-B / EMVCo y flujo directo de pago")
struct BrebQRParserTests {
    private static func tlv(_ tag: String, _ value: String) -> String {
        let len = String(format: "%02d", value.unicodeScalars.count)
        return "\(tag)\(len)\(value)"
    }

    private static func buildEmvQR(_ fields: [(String, String)]) -> String {
        let body = fields.map { tlv($0.0, $0.1) }.joined() + "6304"
        return body + BrebQRParser.computeEmvCRC16(body)
    }

    @Test("Decodifica QR EMVCo P2P de Redeban con hash SHA-256 en Tag 91 y CRC-16 en Tag 63")
    func parsesColombianP2PEmvQR() {
        let qr = Self.buildEmvQR([
            ("00", "01"),
            ("01", "11"),
            ("26", Self.tlv("00", "CO.COM.RBM.LLA") + Self.tlv("02", "3001234567")),
            ("49", Self.tlv("00", "CO.COM.RBM.RED") + Self.tlv("01", "RBM")),
            ("52", "0000"),
            ("53", "170"),
            ("58", "CO"),
            ("59", "JUAN PEREZ"),
            ("60", "BOGOTA"),
            ("91", Self.tlv("00", "CO.COM.RBM.SEC") + Self.tlv("01", "AbCdEfGhIjKlMnOpQrStUv/1/FmX8y2/8voR3Pqw4PwIs2")),
        ])

        guard case .valid(let parsed) = BrebQRParser.parse(qr) else {
            Issue.record("Se esperaba un QR EMVCo válido")
            return
        }
        #expect(parsed.isEmvCo)
        #expect(parsed.crcValid == true)
        #expect(parsed.primaryKey == "3001234567")
        #expect(parsed.candidateKeys == ["3001234567"])
        #expect(parsed.isMerchant == false)
        #expect(parsed.merchantName == "JUAN PEREZ")
        #expect(BrebKeyKind.detect(qr) == .phone)
    }

    @Test("Decodifica QR EMVCo dinámico de comercio con Código Único en Tag 50, monto en Tag 54 y factura en Tag 62")
    func parsesColombianMerchantDynamicEmvQR() {
        let qr = Self.buildEmvQR([
            ("00", "01"),
            ("01", "12"),
            ("49", Self.tlv("00", "CO.COM.RBM.RED") + Self.tlv("01", "RBM")),
            ("50", Self.tlv("00", "CO.COM.RBM.CU") + Self.tlv("01", "12345678")),
            ("52", "5814"),
            ("53", "170"),
            ("54", "25000.00"),
            ("58", "CO"),
            ("59", "CAFE SAN ALBERTO"),
            ("60", "MEDELLIN"),
            ("62", Self.tlv("01", "FAC-102") + Self.tlv("05", "MESA-4")),
            ("91", Self.tlv("00", "CO.COM.RBM.SEC") + Self.tlv("01", "ZxYwVuTsRqPoNmLkJiHgFe/1/FmX8y2/8voR3Pqw4PwIs2")),
        ])

        guard case .valid(let parsed) = BrebQRParser.parse(qr) else {
            Issue.record("Se esperaba un QR de comercio válido")
            return
        }
        #expect(parsed.isEmvCo)
        #expect(parsed.crcValid == true)
        #expect(parsed.initiationMethod == .dynamicQR)
        #expect(parsed.isMerchant)
        #expect(parsed.candidateKeys == ["12345678", "0012345678"])
        #expect(parsed.amountMinor == 2_500_000)
        #expect(parsed.merchantName == "CAFE SAN ALBERTO")
        #expect(parsed.reference == "FAC-102")
        #expect(BrebKeyKind.detect("0012345678") == .merchantCode)
    }

    @Test("Decodifica enlaces de pago y rechaza QRs no financieros")
    func parsesPaymentURLAndRejectsUnsupported() {
        if case .valid(let parsed) = BrebQRParser.parse("https://cuypay.com/pay?key=@PanaderiaLaPaz&amount=15000&ref=PED-88&merchant=1") {
            #expect(parsed.primaryKey == "@panaderialapaz")
            #expect(parsed.amountMinor == 1_500_000)
            #expect(parsed.reference == "PED-88")
            #expect(parsed.isMerchant)
        } else {
            Issue.record("Se esperaba URL de pago válida")
        }

        if case .unsupportedQR = BrebQRParser.parse("WIFI:S:Cafeteria;T:WPA;P:secreto123;;") {
            // OK
        } else {
            Issue.record("Un QR de Wi-Fi debe rechazarse como no compatible")
        }
    }

    @Test("SendFlowModel resuelve QR de comercio y avanza directo a Monto → Resumen → Comprobante")
    @MainActor
    func sendFlowResolvesMerchantQRDirectly() async {
        let api = MockAPIClient(latency: .zero)
        let store = WalletStore(api: api)
        await store.refreshAll()

        let model = SendFlowModel(api: api, preselected: nil)
        let merchantQR = Self.buildEmvQR([
            ("00", "01"),
            ("01", "12"),
            ("50", Self.tlv("00", "CO.COM.RBM.CU") + Self.tlv("01", "0012345678")),
            ("52", "5814"),
            ("53", "170"),
            ("54", "18500"),
            ("58", "CO"),
            ("59", "CAFE SAN ALBERTO"),
            ("60", "BOGOTA"),
            ("62", Self.tlv("01", "ORD-774")),
        ])

        await model.resolveAndSelect(rawInput: merchantQR, existingBeneficiaries: store.beneficiaries)
        #expect(model.hasRecipient)
        #expect(model.recipientIsMerchant)
        #expect(model.recipientAlias == "0012345678")
        #expect(model.recipientDisplayName == "CAFE SAN ALBERTO")
        #expect(model.input.minorUnits == 1_850_000)
        #expect(model.note == "ORD-774")
        #expect(model.path == [.amount])

        await model.requestPreview()
        #expect(model.preview?.amountMinor == 1_850_000)
        #expect(model.path == [.amount, .review])

        await model.send(store: store)
        #expect(model.transaction?.amountMinor == 1_850_000)
        #expect(model.path == [.amount, .review, .receipt])
    }
}
