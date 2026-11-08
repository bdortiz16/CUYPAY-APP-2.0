import Foundation
import LocalAuthentication

/// Autenticación biométrica local (desbloqueo de la app tras >2 min en segundo plano).
/// Las operaciones sensibles NO usan esto: usan la firma del Secure Enclave (ver `SecureEnclaveKeyManager`).
enum BiometricAuthenticator {
    enum BiometryKind: Sendable {
        case faceID, touchID, opticID, none
    }

    static func availableBiometry() -> BiometryKind {
        let context = LAContext()
        var error: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error) else { return .none }
        switch context.biometryType {
        case .faceID: return .faceID
        case .touchID: return .touchID
        case .opticID: return .opticID
        case .none: return .none
        @unknown default: return .none
        }
    }

    /// Pide Face ID. Devuelve `true` si se autenticó.
    /// En DEBUG, si el dispositivo/simulador no tiene biometría, permite continuar (con aviso).
    static func authenticate(reason: String) async -> Bool {
        let context = LAContext()
        var error: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error) else {
            #if DEBUG
            print("⚠️ [CuyPay] Biometría no disponible; desbloqueo permitido solo en DEBUG.")
            return true
            #else
            return false
            #endif
        }
        do {
            return try await context.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: reason)
        } catch {
            return false
        }
    }
}
