import Foundation
import PassKit
import UIKit

/// Coordinador de aprovisionamiento de Apple Wallet (PassKit).
/// Soporta In-App Push Provisioning (`PKAddPaymentPassViewController`) cuando el entitlement
/// `com.apple.developer.payment-pass-provisioning` está activo en el perfil de firma, y permite
/// abrir directamente la configuración de tarjetas de Apple Wallet (`PKPassLibrary().openPaymentSetup()`)
/// para aprovisionamiento manual.
final class AppleWalletProvisioningCoordinator: NSObject, PKAddPaymentPassViewControllerDelegate, @unchecked Sendable {
    private struct PassRequestHandlerBox: @unchecked Sendable {
        let handler: (PKAddPaymentPassRequest) -> Void
    }

    private let cardId: String
    private let api: any CuyPayAPI
    private let onComplete: @MainActor @Sendable (Bool) -> Void

    init(
        cardId: String,
        api: any CuyPayAPI,
        onComplete: @escaping @MainActor @Sendable (Bool) -> Void
    ) {
        self.cardId = cardId
        self.api = api
        self.onComplete = onComplete
        super.init()
    }

    @MainActor
    static func presentInAppProvisioningIfAvailable(
        card: CardItem,
        holderName: String,
        api: any CuyPayAPI,
        onComplete: @escaping @MainActor @Sendable (Bool) -> Void
    ) -> AppleWalletProvisioningCoordinator? {
        guard PKAddPaymentPassViewController.canAddPaymentPass() else {
            return nil
        }
        guard let config = PKAddPaymentPassRequestConfiguration(encryptionScheme: .ECC_V2) else {
            return nil
        }
        config.cardholderName = holderName
        if card.lastFour.count == 4 && card.lastFour != "0000" {
            config.primaryAccountSuffix = card.lastFour
        }
        config.localizedDescription = card.label
        config.paymentNetwork = card.brand.lowercased().contains("master") ? .masterCard : .visa

        let coordinator = AppleWalletProvisioningCoordinator(
            cardId: card.id,
            api: api,
            onComplete: onComplete
        )
        guard let controller = PKAddPaymentPassViewController(requestConfiguration: config, delegate: coordinator),
              let topPresenter = topViewController()
        else {
            return nil
        }

        topPresenter.present(controller, animated: true)
        return coordinator
    }

    @MainActor
    static func openAppleWalletSetup() {
        PKPassLibrary().openPaymentSetup()
    }

    // MARK: - PKAddPaymentPassViewControllerDelegate

    nonisolated func addPaymentPassViewController(
        _ controller: PKAddPaymentPassViewController,
        generateRequestWithCertificateChain certificates: [Data],
        nonce: Data,
        nonceSignature: Data,
        handler: @escaping (PKAddPaymentPassRequest) -> Void
    ) {
        let box = PassRequestHandlerBox(handler: handler)
        let api = self.api
        let cardId = self.cardId
        let certBase64 = certificates.map { $0.base64EncodedString() }
        let nonceBase64 = nonce.base64EncodedString()
        let sigBase64 = nonceSignature.base64EncodedString()

        Task {
            let passRequest = PKAddPaymentPassRequest()
            do {
                let res = try await api.tokenizeApplePay(
                    id: cardId,
                    certificates: certBase64,
                    nonce: nonceBase64,
                    nonceSignature: sigBase64
                )
                passRequest.activationData = Self.decodeData(res.activationData)
                passRequest.encryptedPassData = Self.decodeData(res.encryptedPassData)
                passRequest.ephemeralPublicKey = Self.decodeData(res.ephemeralPublicKey)
            } catch {
                // Devolver PKAddPaymentPassRequest vacío indica a PassKit que no se pudo aprovisionar.
            }
            box.handler(passRequest)
        }
    }

    nonisolated func addPaymentPassViewController(
        _ controller: PKAddPaymentPassViewController,
        didFinishAdding pass: PKPaymentPass?,
        error: (any Error)?
    ) {
        let succeeded = (pass != nil && error == nil)
        let onComplete = self.onComplete
        Task { @MainActor in
            controller.dismiss(animated: true) {
                onComplete(succeeded)
            }
        }
    }

    // MARK: - Helpers

    private nonisolated static func decodeData(_ raw: String) -> Data? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        if let b64 = Data(base64Encoded: trimmed) {
            return b64
        }
        return decodeHex(trimmed)
    }

    private nonisolated static func decodeHex(_ hexString: String) -> Data? {
        let clean = hexString.replacingOccurrences(of: " ", with: "")
        guard clean.count.isMultiple(of: 2), !clean.isEmpty else { return nil }
        var bytes = Data(capacity: clean.count / 2)
        var index = clean.startIndex
        while index < clean.endIndex {
            let next = clean.index(index, offsetBy: 2)
            guard let byte = UInt8(clean[index..<next], radix: 16) else { return nil }
            bytes.append(byte)
            index = next
        }
        return bytes
    }

    @MainActor
    private static func topViewController() -> UIViewController? {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        let keyWindow = scenes
            .flatMap(\.windows)
            .first(where: \.isKeyWindow) ?? scenes.flatMap(\.windows).first
        var top = keyWindow?.rootViewController
        while let presented = top?.presentedViewController {
            top = presented
        }
        return top
    }
}
