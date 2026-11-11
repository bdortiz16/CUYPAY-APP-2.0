import Foundation
import UIKit
@preconcurrency import UserNotifications

/// Gestiona permisos, token APNs y notificaciones nativas inmediatas (banner + sonido)
/// cuando ingresa dinero a la cuenta del cliente (tanto en segundo plano como en primer plano).
@MainActor
final class DepositNotificationManager: NSObject, UNUserNotificationCenterDelegate {
    static let shared = DepositNotificationManager()

    private(set) var apnsTokenHex: String?
    var onTokenReceived: (@MainActor (String) -> Void)?
    private var isConfigured = false

    static var apnsEnvironment: String {
        #if DEBUG
        return "sandbox"
        #else
        return "production"
        #endif
    }

    private var isRunningInPreview: Bool {
        ProcessInfo.processInfo.environment["XCODE_RUNNING_FOR_PREVIEWS"] == "1"
    }

    func configure() {
        guard !isRunningInPreview, !isConfigured else { return }
        isConfigured = true
        UNUserNotificationCenter.current().delegate = self
    }

    func requestAuthorizationAndRegister() async {
        guard !isRunningInPreview else { return }
        configure()
        let center = UNUserNotificationCenter.current()
        _ = try? await center.requestAuthorization(options: [.alert, .sound, .badge])
        UIApplication.shared.registerForRemoteNotifications()
    }

    func handleDeviceToken(_ deviceToken: Data) {
        let hex = deviceToken.map { String(format: "%02x", $0) }.joined()
        guard !hex.isEmpty else { return }
        apnsTokenHex = hex
        onTokenReceived?(hex)
    }

    func notifyIncomingDeposit(_ txn: WalletTransaction) {
        guard !isRunningInPreview else { return }
        configure()

        let amountText = txn.amount.formatted()
        let sender = txn.title.trimmingCharacters(in: .whitespacesAndNewlines)
        let lowerSender = sender.lowercased()
        let hasNamedSender =
            !sender.isEmpty &&
            lowerSender != "depósito bre-b" &&
            lowerSender != "deposito bre-b"

        let content = UNMutableNotificationContent()
        content.title = "¡Recibiste \(amountText)!"
        content.body = hasNamedSender
            ? "Recibiste \(amountText) de \(sender) en tu cuenta CuyPay."
            : "Recibiste \(amountText) por Bre-B en tu cuenta CuyPay."
        content.sound = .default
        content.userInfo = [
            "txnId": txn.id,
            "type": "deposit"
        ]

        let request = UNNotificationRequest(
            identifier: "deposit-\(txn.id)",
            content: content,
            trigger: nil
        )
        UNUserNotificationCenter.current().add(request)
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        [.banner, .list, .sound]
    }
}
