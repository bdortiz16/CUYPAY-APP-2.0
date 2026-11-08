import Foundation

/// Custodia de credenciales de sesión.
/// - `accessToken`: **solo en memoria** (JWT de 15 min).
/// - `refreshToken`: Keychain `WhenUnlockedThisDeviceOnly` (30 días, rotativo).
/// - `deviceId`: Keychain (identifica la clave del Secure Enclave registrada en el backend).
actor TokenStore {
    private let keychain: KeychainStore
    private(set) var accessToken: String?
    private(set) var accessTokenExpiry: Date?

    init(keychain: KeychainStore = KeychainStore()) {
        self.keychain = keychain
    }

    var refreshToken: String? {
        try? keychain.string(for: KeychainAccount.refreshToken)
    }

    var deviceId: String? {
        try? keychain.string(for: KeychainAccount.deviceId)
    }

    /// ¿El access token vence en menos de `margin` segundos?
    func accessTokenNeedsRefresh(margin: TimeInterval = 60) -> Bool {
        guard accessToken != nil, let accessTokenExpiry else { return true }
        return accessTokenExpiry.timeIntervalSinceNow < margin
    }

    func store(_ session: AuthSession) throws {
        accessToken = session.accessToken
        accessTokenExpiry = Date().addingTimeInterval(TimeInterval(session.expiresIn))
        try keychain.set(session.refreshToken, for: KeychainAccount.refreshToken)
        try keychain.set(session.deviceId, for: KeychainAccount.deviceId)
    }

    /// Cierra sesión: borra tokens pero conserva `deviceId` (para volver a entrar con Face ID).
    func clearSession() {
        accessToken = nil
        accessTokenExpiry = nil
        try? keychain.delete(KeychainAccount.refreshToken)
    }

    /// Olvida el dispositivo por completo (re-enrolamiento).
    func clearAll() {
        clearSession()
        try? keychain.delete(KeychainAccount.deviceId)
    }
}
