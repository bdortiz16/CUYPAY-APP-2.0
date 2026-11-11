@preconcurrency import BackgroundTasks
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

    nonisolated static let bgRefreshIdentifier = "com.cuypay.app.refresh"
    private static weak var sharedForBackgroundRefresh: AppModel?
    private static var didRegisterBackgroundTask = false

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
        guard UserDefaults.standard.object(forKey: Self.autoLockKey) != nil else { return 60 }
        let val = UserDefaults.standard.double(forKey: Self.autoLockKey)
        return [0, 60, 300, 900].contains(Int(val)) ? val : 60
    }

    init(environment: AppEnvironment, api: any CuyPayAPI, deviceKeys: any DeviceSigning) {
        self.environment = environment
        self.api = api
        self.deviceKeys = deviceKeys
        self.kyc = KYCService(api: api, simulate: environment.isMock)
        let store = WalletStore(api: api)
        self.store = store
        store.onSessionExpired = { [weak self] in
            guard let self, self.route == .main else { return }
            withAnimation(.smooth) {
                self.route = .login
            }
        }
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
        let model = AppModel(environment: environment, api: api, deviceKeys: keys)
        sharedForBackgroundRefresh = model
        DepositNotificationManager.shared.onTokenReceived = { [weak model] token in
            guard let model, model.user != nil else { return }
            Task {
                try? await model.api.registerPushToken(token, environment: DepositNotificationManager.apnsEnvironment)
            }
        }
        return model
    }

    /// Modelo para previews de SwiftUI: mock sin latencia, sesión iniciada.
    static func preview(route: Route = .main, kycStatus: KYCStatus = .approved) -> AppModel {
        let environment = AppEnvironment(apiMode: .mock, baseURL: URL(string: "http://localhost:8080/v1")!, name: "Preview")
        let api = MockAPIClient(latency: .zero, signer: nil, startsVerified: kycStatus == .approved)
        let model = AppModel(environment: environment, api: api, deviceKeys: SoftwareSigningKey())
        let previewUser = MockFixtures(now: Date()).user.with(kycStatus: kycStatus, tier: kycStatus == .approved ? .full : .basic)
        model.user = previewUser
        model.store.configureSession(userId: previewUser.id)
        model.route = route
        return model
    }

    var isKYCApproved: Bool { user?.kycStatus == .approved }

    // MARK: - Background Refresh (depósitos en segundo plano)

    static func registerBackgroundRefreshIfNeeded() {
        guard ProcessInfo.processInfo.environment["XCODE_RUNNING_FOR_PREVIEWS"] != "1" else { return }
        guard !didRegisterBackgroundTask else { return }
        didRegisterBackgroundTask = true
        installBackgroundTaskHandler()
    }

    nonisolated private static func installBackgroundTaskHandler() {
        BGTaskScheduler.shared.register(forTaskWithIdentifier: bgRefreshIdentifier, using: nil) { task in
            nonisolated(unsafe) let bgTask = task
            let work = Task { @MainActor in
                Self.scheduleBackgroundRefresh()
                if let model = Self.sharedForBackgroundRefresh, model.user != nil {
                    await model.store.refreshLiveState(allowHaptic: false)
                }
                bgTask.setTaskCompleted(success: true)
            }
            bgTask.expirationHandler = {
                work.cancel()
                bgTask.setTaskCompleted(success: false)
            }
        }
    }

    nonisolated static func scheduleBackgroundRefresh() {
        guard ProcessInfo.processInfo.environment["XCODE_RUNNING_FOR_PREVIEWS"] != "1" else { return }
        let request = BGAppRefreshTaskRequest(identifier: bgRefreshIdentifier)
        request.earliestBeginDate = Date(timeIntervalSinceNow: 5 * 60)
        try? BGTaskScheduler.shared.submit(request)
    }

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
            var digits = phone.filter(\.isASCIIDigit)
            if digits.count == 12 && digits.hasPrefix("57") {
                digits = String(digits.dropFirst(2))
            }
            let formattedPhone = phone.hasPrefix("+") ? phone : (digits.count == 10 ? "+57\(digits)" : phone)
            let pubKey: String?
            if deviceKeys.hasKey(), let existing = try? deviceKeys.publicKeyBase64() {
                pubKey = existing
            } else {
                pubKey = try? await deviceKeys.createKey()
            }
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
        store.configureSession(userId: user.id)
        isLocked = false
        backgroundedAt = nil
        withAnimation(.smooth) { route = .main }
        Task {
            await store.refreshAll()
            await DepositNotificationManager.shared.requestAuthorizationAndRegister()
            if let token = DepositNotificationManager.shared.apnsTokenHex {
                try? await api.registerPushToken(token, environment: DepositNotificationManager.apnsEnvironment)
            }
        }
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

    // MARK: - Ciclo de vida (privacidad + bloqueo + refresco automático)

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
            } else if route == .main {
                Task {
                    await store.refreshLiveState()
                    await refreshUser()
                }
            }
        case .inactive:
            isPrivacyCoverVisible = true
        case .background:
            isPrivacyCoverVisible = true
            if backgroundedAt == nil { backgroundedAt = Date() }
            if user != nil {
                Self.scheduleBackgroundRefresh()
            }
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
