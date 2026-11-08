import Foundation

/// Entorno de ejecución: modo de API (mock/live) y base URL.
///
/// Prioridad: variable de entorno `CUYPAY_API_MODE` / `CUYPAY_API_BASE_URL` (esquema de Xcode)
/// → Info.plist (`CuyPayAPIMode` / `CuyPayAPIBaseURL`, rellenados desde `Config/*.xcconfig`).
/// En builds Release el modo mock está deshabilitado.
struct AppEnvironment: Sendable {
    enum APIMode: String, Sendable {
        case mock
        case live
    }

    let apiMode: APIMode
    let baseURL: URL
    let name: String

    var isMock: Bool { apiMode == .mock }

    static let current: AppEnvironment = {
        let info = Bundle.main.infoDictionary ?? [:]
        let env = ProcessInfo.processInfo.environment

        #if DEBUG
        let modeString = env["CUYPAY_API_MODE"] ?? (info["CuyPayAPIMode"] as? String) ?? "live"
        let mode = APIMode(rawValue: modeString.lowercased()) ?? .live
        #else
        let mode = APIMode.live
        #endif

        let urlString = env["CUYPAY_API_BASE_URL"] ?? (info["CuyPayAPIBaseURL"] as? String) ?? "https://api.cuypay.com/v1"
        let url = URL(string: urlString) ?? URL(string: "https://api.cuypay.com/v1")!
        let name = (info["CuyPayEnvironmentName"] as? String) ?? "Prod"

        return AppEnvironment(apiMode: mode, baseURL: url, name: name)
    }()

    /// ¿Estamos en un preview de Xcode?
    static var isRunningInPreview: Bool {
        ProcessInfo.processInfo.environment["XCODE_RUNNING_FOR_PREVIEWS"] == "1"
    }
}
