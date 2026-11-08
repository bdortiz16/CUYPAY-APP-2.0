import Foundation
import UIKit

#if canImport(IdensicMobileSDK)
@preconcurrency import IdensicMobileSDK
#endif

/// Verificación de identidad con Sumsub (IdensicMobileSDK).
///
/// - El token se obtiene **siempre** del backend (`POST /kyc/sumsub/token`); la app nunca conoce secretos de Sumsub.
/// - Si el SDK pide un token nuevo (`tokenExpirationHandler`), volvemos a llamar al backend.
/// - Si el paquete SPM no está enlazado (`#if canImport`), la app compila igual y la verificación
///   se simula en modo mock o devuelve `.sdkUnavailable` en modo live.
@MainActor
final class KYCService {
    enum Outcome: Sendable, Equatable {
        /// El usuario envió sus documentos; el resultado llega por webhook → consultar `/kyc/status`.
        case submitted
        case approved
        case rejected
        /// Cerró el flujo sin terminar.
        case cancelled
    }

    enum KYCError: Error, LocalizedError {
        case sdkUnavailable
        case sdkNotReady(String)
        case noPresenter

        var errorDescription: String? {
            switch self {
            case .sdkUnavailable:
                String(localized: "La verificación de identidad no está disponible en esta versión.")
            case .sdkNotReady:
                String(localized: "No pudimos iniciar la verificación. Inténtalo de nuevo en unos minutos.")
            case .noPresenter:
                String(localized: "No pudimos abrir la verificación. Inténtalo de nuevo.")
            }
        }
    }

    private let api: any CuyPayAPI
    private let simulate: Bool
    /// Mantiene viva la instancia del SDK mientras está en pantalla.
    private var activeSDK: AnyObject?

    init(api: any CuyPayAPI, simulate: Bool) {
        self.api = api
        self.simulate = simulate
    }

    static var isSDKLinked: Bool {
        #if canImport(IdensicMobileSDK)
        true
        #else
        false
        #endif
    }

    /// Presenta el flujo de Sumsub y espera a que el usuario lo cierre.
    func startVerification() async throws -> Outcome {
        let tokenResponse = try await api.sumsubToken()

        if simulate {
            // Modo demo: simulamos la captura de documentos.
            try? await Task.sleep(for: .seconds(1.2))
            return .submitted
        }

        #if canImport(IdensicMobileSDK)
        let sdk = SNSMobileSDK(accessToken: tokenResponse.token)
        guard sdk.isReady else {
            throw KYCError.sdkNotReady(sdk.verboseStatus)
        }
        guard let presenter = Self.topViewController() else {
            throw KYCError.noPresenter
        }
        activeSDK = sdk
        defer { activeSDK = nil }

        let outcome: Outcome = await withCheckedContinuation { continuation in
            Self.configure(sdk: sdk, api: api, continuation: continuation)
            presenter.present(sdk.mainVC, animated: true)
        }
        return outcome
        #else
        _ = tokenResponse
        throw KYCError.sdkUnavailable
        #endif
    }

    #if canImport(IdensicMobileSDK)
    /// Configura handlers en un contexto `nonisolated` para que los closures no hereden `@MainActor`
    /// (el SDK puede invocarlos desde otros hilos).
    private nonisolated static func configure(
        sdk: SNSMobileSDK,
        api: any CuyPayAPI,
        continuation: CheckedContinuation<Outcome, Never>
    ) {
        #if DEBUG
        sdk.logLevel = .error
        #else
        sdk.logLevel = .off
        #endif

        // Token vencido → pedimos uno nuevo al backend y se lo devolvemos al SDK.
        sdk.tokenExpirationHandler { onComplete in
            let completion = UncheckedSendableBox(onComplete)
            Task {
                if let refreshed = try? await api.sumsubToken() {
                    completion.value(refreshed.token)
                }
            }
        }

        // Se llama exactamente una vez cuando `mainVC` se cierra.
        sdk.onDidDismiss { sdk in
            let outcome: Outcome
            if sdk.status == .approved {
                outcome = .approved
            } else if sdk.status == .finallyRejected {
                outcome = .rejected
            } else if sdk.status == .pending || sdk.status == .temporarilyDeclined {
                outcome = .submitted
            } else {
                outcome = .cancelled
            }
            continuation.resume(returning: outcome)
        }
    }
    #endif

    /// View controller visible para presentar el SDK (UIKit) sobre SwiftUI.
    static func topViewController() -> UIViewController? {
        let scene = UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .first { $0.activationState == .foregroundActive }
        var top = scene?.keyWindow?.rootViewController
        while let presented = top?.presentedViewController {
            top = presented
        }
        return top
    }
}

/// Caja para pasar closures de SDKs Objective-C (no `Sendable`) a un `Task`.
/// Solo usar cuando el SDK documenta que el closure puede invocarse desde cualquier hilo.
struct UncheckedSendableBox<Value>: @unchecked Sendable {
    let value: Value
    init(_ value: Value) { self.value = value }
}
