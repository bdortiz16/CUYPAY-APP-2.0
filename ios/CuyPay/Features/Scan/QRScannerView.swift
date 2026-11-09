import SwiftUI
import AVFoundation

/// Vista para escanear códigos QR (llaves Bre-B o direcciones de pago).
struct QRScannerView: View {
    @Environment(\.dismiss) private var dismiss
    let onScanned: (String) -> Void

    @State private var torchIsOn = false
    @State private var hasCameraAccess = true
    @State private var isCameraAvailable = true
    @State private var manualInput = ""
    @State private var scanLineOffset: CGFloat = -120

    var body: some View {
        NavigationStack {
            ZStack {
                Color.black.ignoresSafeArea()

                if isCameraAvailable && hasCameraAccess {
                    CameraPreviewRepresentable(torchOn: torchIsOn) { rawCode in
                        handleScannedCode(rawCode)
                    }
                    .ignoresSafeArea()

                    // Overlay con visor y animación
                    VStack {
                        Spacer()

                        ZStack {
                            RoundedRectangle(cornerRadius: 24, style: .continuous)
                                .stroke(Theme.spruce, lineWidth: 3)
                                .frame(width: 250, height: 250)
                                .background(Color.black.opacity(0.1))

                            // Línea de escaneo láser animada
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

                        Text("Apunta la cámara al código QR de la llave Bre-B")
                            .font(.subheadline.weight(.medium))
                            .foregroundStyle(.white)
                            .multilineTextAlignment(.center)
                            .padding(.horizontal, 32)
                            .padding(.top, 24)

                        Spacer()

                        HStack(spacing: 24) {
                            Button {
                                torchIsOn.toggle()
                            } label: {
                                Image(systemName: torchIsOn ? "flashlight.on.fill" : "flashlight.off.fill")
                                    .font(.title2)
                                    .foregroundStyle(torchIsOn ? .yellow : .white)
                                    .padding(16)
                                    .background(.ultraThinMaterial, in: Circle())
                            }

                            Button {
                                if let pasteboardString = UIPasteboard.general.string {
                                    handleScannedCode(pasteboardString)
                                }
                            } label: {
                                HStack(spacing: 6) {
                                    Image(systemName: "doc.on.clipboard")
                                    Text("Pegar llave")
                                }
                                .font(.footnote.weight(.semibold))
                                .foregroundStyle(.white)
                                .padding(.horizontal, 18)
                                .padding(.vertical, 12)
                                .background(.ultraThinMaterial, in: Capsule())
                            }
                        }
                        .padding(.bottom, 40)
                    }
                } else {
                    // Fallback para simulador o sin permisos
                    VStack(spacing: 24) {
                        Image(systemName: "qrcode.viewfinder")
                            .font(.system(size: 64))
                            .foregroundStyle(Theme.spruce)

                        VStack(spacing: 8) {
                            Text("Escanear Código QR")
                                .font(.title2.weight(.bold))
                                .foregroundStyle(.white)

                            Text(isCameraAvailable ? "Se requiere permiso de cámara para escanear." : "Cámara no disponible en este entorno.")
                                .font(.subheadline)
                                .foregroundStyle(.white.opacity(0.7))
                                .multilineTextAlignment(.center)
                        }

                        VStack(spacing: 12) {
                            Button {
                                if let string = UIPasteboard.general.string, !string.isEmpty {
                                    handleScannedCode(string)
                                }
                            } label: {
                                Label("Pegar del portapapeles", systemImage: "doc.on.clipboard")
                                    .font(.body.weight(.semibold))
                                    .frame(maxWidth: .infinity)
                                    .padding(.vertical, 14)
                                    .background(Theme.spruce)
                                    .foregroundStyle(.white)
                                    .clipShape(RoundedRectangle(cornerRadius: 16))
                            }

                            HStack {
                                TextField("O escribe la llave manualmente", text: $manualInput)
                                    .textFieldStyle(.plain)
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
                DispatchQueue.main.async {
                    self.hasCameraAccess = granted
                    self.isCameraAvailable = granted
                }
            }
        default:
            hasCameraAccess = false
        }
        #endif
    }

    private func handleScannedCode(_ raw: String) {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }

        // Si es una URL con parámetro de llave o breb
        var finalKey = trimmed
        if let url = URL(string: trimmed), let components = URLComponents(url: url, resolvingAgainstBaseURL: false) {
            if let keyParam = components.queryItems?.first(where: { $0.name == "key" || $0.name == "alias" })?.value {
                finalKey = keyParam
            }
        }

        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
        onScanned(finalKey)
        dismiss()
    }
}

// MARK: - UIKit Camera Preview Representable

private struct CameraPreviewRepresentable: UIViewControllerRepresentable {
    let torchOn: Bool
    let onScanned: (String) -> Void

    func makeUIViewController(context: Context) -> CameraScannerViewController {
        let vc = CameraScannerViewController()
        vc.onCodeFound = onScanned
        return vc
    }

    func updateUIViewController(_ uiViewController: CameraScannerViewController, context: Context) {
        uiViewController.setTorch(torchOn)
    }
}

private class CameraScannerViewController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
    var onCodeFound: ((String) -> Void)?
    private var captureSession: AVCaptureSession?
    private var previewLayer: AVCaptureVideoPreviewLayer?
    private var hasReported = false

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        setupCamera()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        previewLayer?.frame = view.bounds
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        if captureSession?.isRunning == true {
            captureSession?.stopRunning()
        }
    }

    func setTorch(_ on: Bool) {
        guard let device = AVCaptureDevice.default(for: .video), device.hasTorch else { return }
        try? device.lockForConfiguration()
        device.torchMode = on ? .on : .off
        device.unlockForConfiguration()
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
                output.setMetadataObjectsDelegate(self, queue: DispatchQueue.main)
                output.metadataObjectTypes = [.qr]
            }

            let preview = AVCaptureVideoPreviewLayer(session: session)
            preview.videoGravity = .resizeAspectFill
            preview.frame = view.bounds
            view.layer.addSublayer(preview)

            self.previewLayer = preview
            self.captureSession = session

            DispatchQueue.global(qos: .userInitiated).async {
                session.startRunning()
            }
        } catch {
            // Error al inicializar cámara
        }
    }

    func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput metadataObjects: [AVMetadataObject], from connection: AVCaptureConnection) {
        guard !hasReported, let metadata = metadataObjects.first as? AVMetadataMachineReadableCodeObject, let str = metadata.stringValue else {
            return
        }
        hasReported = true
        captureSession?.stopRunning()
        DispatchQueue.main.async { [weak self] in
            self?.onCodeFound?(str)
        }
    }
}
