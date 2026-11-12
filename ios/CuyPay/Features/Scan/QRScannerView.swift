import SwiftUI
@preconcurrency import AVFoundation
import PhotosUI
import CoreImage
import UIKit

/// Vista para escanear códigos QR interoperables Bre-B / EMVCo (clientes y comercios).
struct QRScannerView: View {
    @Environment(\.dismiss) private var dismiss
    private let onScannedPayload: (ParsedBrebQR) -> Void

    @State private var torchIsOn = false
    @State private var hasCameraAccess = true
    @State private var isCameraAvailable = true
    @State private var manualInput = ""
    @State private var scanLineOffset: CGFloat = -120
    @State private var scanErrorMessage: String?
    @State private var scannerSessionToken = 0
    @State private var selectedPhotoItem: PhotosPickerItem?

    init(onScannedPayload: @escaping (ParsedBrebQR) -> Void) {
        self.onScannedPayload = onScannedPayload
    }

    init(onScanned: @escaping (String) -> Void) {
        self.onScannedPayload = { parsed in
            onScanned(parsed.primaryKey)
        }
    }

    var body: some View {
        NavigationStack {
            ZStack {
                Color.black.ignoresSafeArea()

                if isCameraAvailable && hasCameraAccess {
                    CameraPreviewRepresentable(torchOn: torchIsOn, sessionToken: scannerSessionToken) { rawCode in
                        handleScannedCode(rawCode)
                    }
                    .ignoresSafeArea()

                    VStack {
                        Spacer()

                        ZStack {
                            RoundedRectangle(cornerRadius: 24, style: .continuous)
                                .stroke(Theme.spruce, lineWidth: 3)
                                .frame(width: 250, height: 250)
                                .background(Color.black.opacity(0.1))

                            Rectangle()
                                .fill(
                                    LinearGradient(
                                        colors: [Theme.spruce.opacity(0), Theme.spruce, Theme.spruce.opacity(0)],
                                        startPoint: .leading,
                                        endPoint: .trailing
                                    )
                                )
                                .frame(width: 230, height: 2)
                                .offset(y: scanLineOffset)
                        }

                        Text("Apunta al código QR Bre-B del cliente o comercio")
                            .font(.subheadline.weight(.medium))
                            .foregroundStyle(.white)
                            .multilineTextAlignment(.center)
                            .padding(.horizontal, 32)
                            .padding(.top, 24)

                        if let scanErrorMessage {
                            HStack(spacing: 8) {
                                Image(systemName: "exclamationmark.triangle.fill")
                                    .foregroundStyle(.yellow)
                                Text(scanErrorMessage)
                                    .font(.footnote.weight(.medium))
                                    .foregroundStyle(.white)
                                    .multilineTextAlignment(.leading)
                            }
                            .padding(.horizontal, 16)
                            .padding(.vertical, 12)
                            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                            .padding(.horizontal, 24)
                            .padding(.top, 14)
                            .transition(.opacity.combined(with: .move(edge: .bottom)))
                        }

                        Spacer()

                        HStack(spacing: 14) {
                            Button {
                                torchIsOn.toggle()
                            } label: {
                                Image(systemName: torchIsOn ? "flashlight.on.fill" : "flashlight.off.fill")
                                    .font(.title3)
                                    .foregroundStyle(torchIsOn ? .yellow : .white)
                                    .padding(14)
                                    .background(.ultraThinMaterial, in: Circle())
                            }

                            PhotosPicker(selection: $selectedPhotoItem, matching: .images) {
                                HStack(spacing: 6) {
                                    Image(systemName: "photo.on.rectangle")
                                    Text("Galería")
                                }
                                .font(.footnote.weight(.semibold))
                                .foregroundStyle(.white)
                                .padding(.horizontal, 16)
                                .padding(.vertical, 12)
                                .background(.ultraThinMaterial, in: Capsule())
                            }

                            Button {
                                if let pasteboardString = UIPasteboard.general.string {
                                    handleScannedCode(pasteboardString)
                                }
                            } label: {
                                HStack(spacing: 6) {
                                    Image(systemName: "doc.on.clipboard")
                                    Text("Pegar")
                                }
                                .font(.footnote.weight(.semibold))
                                .foregroundStyle(.white)
                                .padding(.horizontal, 16)
                                .padding(.vertical, 12)
                                .background(.ultraThinMaterial, in: Capsule())
                            }
                        }
                        .padding(.bottom, 40)
                    }
                } else {
                    VStack(spacing: 24) {
                        Image(systemName: "qrcode.viewfinder")
                            .font(.system(size: 64))
                            .foregroundStyle(Theme.spruce)

                        VStack(spacing: 8) {
                            Text("Escanear Código QR")
                                .font(.title2.weight(.bold))
                                .foregroundStyle(.white)

                            Text(isCameraAvailable ? "Se requiere permiso de cámara para escanear." : "Selecciona una imagen con QR o pega la llave Bre-B.")
                                .font(.subheadline)
                                .foregroundStyle(.white.opacity(0.7))
                                .multilineTextAlignment(.center)
                        }

                        if let scanErrorMessage {
                            Text(scanErrorMessage)
                                .font(.footnote.weight(.medium))
                                .foregroundStyle(.yellow)
                                .multilineTextAlignment(.center)
                                .padding(.horizontal, 16)
                        }

                        VStack(spacing: 12) {
                            PhotosPicker(selection: $selectedPhotoItem, matching: .images) {
                                Label("Elegir imagen de QR", systemImage: "photo.on.rectangle")
                                    .font(.body.weight(.semibold))
                                    .frame(maxWidth: .infinity)
                                    .padding(.vertical, 14)
                                    .background(Theme.spruce)
                                    .foregroundStyle(.white)
                                    .clipShape(RoundedRectangle(cornerRadius: 16))
                            }

                            Button {
                                if let string = UIPasteboard.general.string, !string.isEmpty {
                                    handleScannedCode(string)
                                }
                            } label: {
                                Label("Pegar del portapapeles", systemImage: "doc.on.clipboard")
                                    .font(.body.weight(.semibold))
                                    .frame(maxWidth: .infinity)
                                    .padding(.vertical, 14)
                                    .background(Color.white.opacity(0.14))
                                    .foregroundStyle(.white)
                                    .clipShape(RoundedRectangle(cornerRadius: 16))
                            }

                            HStack {
                                TextField("O escribe la llave manualmente", text: $manualInput)
                                    .textFieldStyle(.plain)
                                    .textInputAutocapitalization(.never)
                                    .autocorrectionDisabled()
                                    .padding(14)
                                    .background(Color.white.opacity(0.12))
                                    .clipShape(RoundedRectangle(cornerRadius: 14))
                                    .foregroundStyle(.white)

                                Button {
                                    if !manualInput.isEmpty {
                                        handleScannedCode(manualInput)
                                    }
                                } label: {
                                    Image(systemName: "arrow.right.circle.fill")
                                        .font(.title)
                                        .foregroundStyle(Theme.spruce)
                                }
                            }
                        }
                        .padding(.horizontal, 24)
                    }
                    .padding(24)
                }
            }
            .navigationTitle("Escanear QR")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Cerrar") { dismiss() }
                        .foregroundStyle(.white)
                }
            }
            .onChange(of: selectedPhotoItem) { _, newItem in
                guard let newItem else { return }
                Task { await decodeQRFromPhoto(newItem) }
            }
            .onAppear {
                checkCameraPermission()
                withAnimation(.easeInOut(duration: 1.8).repeatForever(autoreverses: true)) {
                    scanLineOffset = 120
                }
            }
        }
    }

    private func checkCameraPermission() {
        #if targetEnvironment(simulator)
        isCameraAvailable = false
        #else
        let status = AVCaptureDevice.authorizationStatus(for: .video)
        switch status {
        case .authorized:
            hasCameraAccess = true
            isCameraAvailable = true
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .video) { granted in
                Task { @MainActor in
                    self.hasCameraAccess = granted
                    self.isCameraAvailable = granted
                }
            }
        default:
            hasCameraAccess = false
        }
        #endif
    }

    @MainActor
    private func decodeQRFromPhoto(_ item: PhotosPickerItem) async {
        defer { selectedPhotoItem = nil }
        guard let data = try? await item.loadTransferable(type: Data.self),
              let ciImage = CIImage(data: data) else {
            showTransientError("No se pudo leer la imagen seleccionada.")
            return
        }
        let context = CIContext()
        let detector = CIDetector(
            ofType: CIDetectorTypeQRCode,
            context: context,
            options: [CIDetectorAccuracy: CIDetectorAccuracyHigh]
        )
        let features = detector?.features(in: ciImage) ?? []
        let qrFeature = features.compactMap { $0 as? CIQRCodeFeature }.first(where: { !($0.messageString ?? "").isEmpty })
        guard let payload = qrFeature?.messageString else {
            showTransientError("No encontramos ningún código QR en la imagen.")
            return
        }
        handleScannedCode(payload)
    }

    @MainActor
    private func showTransientError(_ message: String) {
        UINotificationFeedbackGenerator().notificationOccurred(.error)
        withAnimation(.snappy) {
            scanErrorMessage = message
        }
        Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(1600))
            scannerSessionToken &+= 1
        }
    }

    @MainActor
    private func handleScannedCode(_ raw: String) {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }

        switch BrebQRParser.parse(trimmed) {
        case .valid(let parsed):
            scanErrorMessage = nil
            UIImpactFeedbackGenerator(style: .medium).impactOccurred()
            onScannedPayload(parsed)
            dismiss()
        case .unsupportedQR(let reason):
            showTransientError(reason)
        }
    }
}

// MARK: - UIKit Camera Preview Representable

private final class SendableCaptureSessionBox: @unchecked Sendable {
    let session: AVCaptureSession
    init(_ session: AVCaptureSession) {
        self.session = session
    }
}

private struct CameraPreviewRepresentable: UIViewControllerRepresentable {
    let torchOn: Bool
    let sessionToken: Int
    let onScanned: (String) -> Void

    func makeUIViewController(context: Context) -> CameraScannerViewController {
        let vc = CameraScannerViewController()
        vc.onCodeFound = onScanned
        return vc
    }

    func updateUIViewController(_ uiViewController: CameraScannerViewController, context: Context) {
        uiViewController.setTorch(torchOn)
        uiViewController.resumeIfNeeded(token: sessionToken)
    }
}

private final class QRScannerCoordinator: NSObject, AVCaptureMetadataOutputObjectsDelegate, @unchecked Sendable {
    var onCodeFound: (@MainActor (String) -> Void)?
    private var hasReported = false

    func reset() {
        hasReported = false
    }

    func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput metadataObjects: [AVMetadataObject], from connection: AVCaptureConnection) {
        guard !hasReported,
              let metadata = metadataObjects.first as? AVMetadataMachineReadableCodeObject,
              let str = metadata.stringValue else {
            return
        }
        hasReported = true
        Task { @MainActor [weak self] in
            self?.onCodeFound?(str)
        }
    }
}

private final class CameraScannerViewController: UIViewController {
    var onCodeFound: ((String) -> Void)?
    private var sessionBox: SendableCaptureSessionBox?
    private var previewLayer: AVCaptureVideoPreviewLayer?
    private let coordinator = QRScannerCoordinator()
    private var lastSessionToken = 0

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        coordinator.onCodeFound = { [weak self] str in
            if let box = self?.sessionBox {
                DispatchQueue.global(qos: .userInitiated).async {
                    if box.session.isRunning {
                        box.session.stopRunning()
                    }
                }
            }
            self?.onCodeFound?(str)
        }
        setupCamera()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        previewLayer?.frame = view.bounds
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        if let box = sessionBox {
            DispatchQueue.global(qos: .userInitiated).async {
                if box.session.isRunning {
                    box.session.stopRunning()
                }
            }
        }
    }

    func setTorch(_ on: Bool) {
        guard let device = AVCaptureDevice.default(for: .video), device.hasTorch else { return }
        try? device.lockForConfiguration()
        device.torchMode = on ? .on : .off
        device.unlockForConfiguration()
    }

    func resumeIfNeeded(token: Int) {
        guard token != lastSessionToken else { return }
        lastSessionToken = token
        coordinator.reset()
        guard let box = sessionBox else { return }
        DispatchQueue.global(qos: .userInitiated).async {
            if !box.session.isRunning {
                box.session.startRunning()
            }
        }
    }

    private func setupCamera() {
        guard let device = AVCaptureDevice.default(for: .video) else { return }
        do {
            let input = try AVCaptureDeviceInput(device: device)
            let session = AVCaptureSession()
            session.sessionPreset = .high

            if session.canAddInput(input) {
                session.addInput(input)
            }

            let output = AVCaptureMetadataOutput()
            if session.canAddOutput(output) {
                session.addOutput(output)
                output.setMetadataObjectsDelegate(coordinator, queue: DispatchQueue.main)
                output.metadataObjectTypes = [.qr]
            }

            let preview = AVCaptureVideoPreviewLayer(session: session)
            preview.videoGravity = .resizeAspectFill
            preview.frame = view.bounds
            view.layer.addSublayer(preview)

            let box = SendableCaptureSessionBox(session)
            self.previewLayer = preview
            self.sessionBox = box

            DispatchQueue.global(qos: .userInitiated).async {
                box.session.startRunning()
            }
        } catch {
            // Error al inicializar cámara
        }
    }
}
