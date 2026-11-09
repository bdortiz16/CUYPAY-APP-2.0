import Foundation
import Observation
import SwiftUI
import UIKit

/// Estado global: sesión, ruta raíz, dependencias y bloqueo de la app.
@Observable
@MainActor
final class AppModel {
    enum Route: Equatable {
        case launching
        case onboarding
        case login
        case main
    }

    // MARK: Dependencias
    let environment: AppEnvironment
    let api: any CuyPayAPI
    let deviceKeys: any DeviceSigning
    let kyc: KYCService
    let store: WalletStore

    // MARK: Estado
    var route: Route = .launching
    var user: User?
    var isAuthenticating = false
    var loginError: String?

    /// Ocultar montos (ojo tachado): se persiste con `@AppStorage(AppModel.hideAmountsKey)` en las vistas.
    nonisolated static let hideAmountsKey = "hideAmounts"
    nonisolated static let autoLockKey = "autoLockInterval"

    // MARK: Bloqueo de la app
    /// Cubre el contenido cuando la app no está activa (multitarea / capturas del sistema).
    var isPrivacyCoverVisible = false
    /// Requiere Face ID para continuar (tras > `lockAfter` en segundo plano).
    var isLocked = false
    private var backgroundedAt: Date?
    var autoLockSeconds: TimeInterval {
        let val = UserDefaults.standard.double(forKey: Self.autoLockKey)
        return val > 0 ? val : 60
    }

    init(environment: AppEnvironment, api: any CuyPayAPI, deviceKeys: any DeviceSigning) {
        self.environment = environment
        self.api = api
        self.deviceKeys = deviceKeys
        self.kyc = KYCService(api: api, simulate: environment.isMock)
        self.store = WalletStore(api: api)
    }

    /// Composición de dependencias según el entorno.
    static func live() -> AppModel {
        let environment = AppEnvironment.current
        let keys = SecureEnclaveKeyManager()
        let api: any CuyPayAPI
        if environment.isMock {
            api = MockAPIClient(signer: keys, startsVerified: true)
        } else {
            api = APIClient(baseURL: environment.baseURL, tokens: TokenStore(), deviceSigner: keys)
        }
        return AppModel(environment: environment, api: api, deviceKeys: keys)
    }

    /// Modelo para previews de SwiftUI: mock sin latencia, sesión iniciada.
    static func preview(route: Route = .main, kycStatus: KYCStatus = .approved) -> AppModel {
        let environment = AppEnvironment(apiMode: .mock, baseURL: URL(string: "http://localhost:8080/v1")!, name: "Preview")
        let api = MockAPIClient(latency: .zero, signer: nil, startsVerified: kycStatus == .approved)
        let model = AppModel(environment: environment, api: api, deviceKeys: SoftwareSigningKey())
        model.user = MockFixtures(now: Date()).user.with(kycStatus: kycStatus, tier: kycStatus == .approved ? .full : .basic)
        model.route = route
        return model
    }

    var isKYCApproved: Bool { user?.kycStatus == .approved }

    // MARK: - Arranque

    func bootstrap() async {
        guard route == .launching else { return }
        let deviceId = await api.storedDeviceId()
        if deviceId != nil, deviceKeys.hasKey() {
            route = .login
        } else {
            route = .onboarding
        }
    }

    // MARK: - Login con Face ID (desafío firmado)

    func loginWithFaceID() async {
        guard !isAuthenticating else { return }
        isAuthenticating = true
        loginError = nil
        defer { isAuthenticating = false }

        do {
            guard let deviceId = await api.storedDeviceId() else {
                route = .onboarding
                return
            }
            let challenge = try await api.challenge(deviceId: deviceId)
            let signature = try await deviceKeys.sign(Data(challenge.nonce.utf8), reason: SignReason.login)
            let session = try await api.login(challengeId: challenge.challengeId, deviceId: deviceId, signature: signature)
            didAuthenticate(session.user)
        } catch DeviceKeyError.biometryCancelled {
            loginError = APIError.biometricCancelled.userMessage
        } catch let error as DeviceKeyError {
            loginError = error == .keyNotFound
                ? String(localized: "No encontramos la llave de este dispositivo. Regístralo de nuevo.")
                : APIError.deviceKeyUnavailable.userMessage
        } catch {
            loginError = error.userMessage
        }
    }

    func loginWithPassword(phone: String, password: String) async -> Bool {
        guard !isAuthenticating else { return false }
        isAuthenticating = true
        loginError = nil
        defer { isAuthenticating = false }

        do {
            let digits = phone.filter(\.isASCIIDigit)
            let formattedPhone = phone.hasPrefix("+") ? phone : (digits.count == 10 ? "+57\(digits)" : phone)
            let pubKey = try? await deviceKeys.createKey()
            let session = try await api.loginWithPassword(
                phone: formattedPhone,
                password: password,
                deviceName: UIDevice.current.name,
                devicePublicKey: pubKey
            )
            didAuthenticate(session.user)
            return true
        } catch {
            loginError = error.userMessage
            return false
        }
    }

    /// Se llama tras login o registro exitoso.
    func didAuthenticate(_ user: User) {
        self.user = user
        isLocked = false
        backgroundedAt = nil
        withAnimation(.smooth) { route = .main }
        Task { await store.refreshAll() }
    }

    /// Atajo para demos en modo mock (sin registro).
    func enterDemo() {
        guard environment.isMock else { return }
        didAuthenticate(MockFixtures(now: Date()).user)
    }

    func refreshUser() async {
        if let fresh = try? await api.me() {
            user = fresh
        }
    }

    /// Actualiza el estado KYC local con la respuesta de `/kyc/status`.
    func apply(kycStatus response: KYCStatusResponse) {
        user?.kycStatus = response.status
        user?.tier = response.tier
    }

    // MARK: - Cerrar sesión

    func logout() async {
        try? await api.logout()
        await api.clearLocalSession()
        store.reset()
        user = nil
        isLocked = false
        withAnimation(.smooth) { route = .login }
    }

    /// Olvida este dispositivo: borra la clave del Secure Enclave y todos los tokens.
    func forgetDevice() async {
        try? await api.logout()
        await api.forgetDevice()
        try? deviceKeys.deleteKey()
        store.reset()
        user = nil
        isLocked = false
        withAnimation(.smooth) { route = .onboarding }
    }

    // MARK: - Ciclo de vida (privacidad + bloqueo)

    func handleScenePhase(_ phase: ScenePhase) {
        switch phase {
        case .active:
            if route == .main, let backgroundedAt, Date().timeIntervalSince(backgroundedAt) > autoLockSeconds {
                isLocked = true
            }
            backgroundedAt = nil
            withAnimation(.easeOut(duration: 0.2)) { isPrivacyCoverVisible = false }
            if isLocked {
                Task { await unlock() }
            }
        case .inactive:
            isPrivacyCoverVisible = true
        case .background:
            isPrivacyCoverVisible = true
            if backgroundedAt == nil { backgroundedAt = Date() }
        @unknown default:
            isPrivacyCoverVisible = true
        }
    }

    func unlock() async {
        let ok = await BiometricAuthenticator.authenticate(reason: String(localized: "Desbloquea CuyPay"))
        if ok {
            withAnimation(.smooth) { isLocked = false }
            Task { await store.refreshAll() }
        }
    }
}
