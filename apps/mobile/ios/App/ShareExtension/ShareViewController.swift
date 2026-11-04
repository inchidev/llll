import UIKit
import UniformTypeIdentifiers

/// L4 in the system share sheet: a screenshot or screen recording becomes a Task
/// on a Server right away, marked later in the app.
final class ShareViewController: UIViewController {
    private let titleLabel = UILabel()
    private let messageLabel = UILabel()
    private let progressView = UIProgressView(progressViewStyle: .default)
    private let serverStack = UIStackView()
    private let doneButton = UIButton(type: .system)
    private var uploader: L4ShareUploader?
    private var file: (url: URL, name: String)?
    private var handedOff = false

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        titleLabel.font = .preferredFont(forTextStyle: .headline)
        titleLabel.text = "Send to L4"
        messageLabel.font = .preferredFont(forTextStyle: .subheadline)
        messageLabel.textColor = .secondaryLabel
        messageLabel.numberOfLines = 0
        progressView.isHidden = true
        serverStack.axis = .vertical
        serverStack.spacing = 8
        doneButton.setTitle("Cancel", for: .normal)
        doneButton.addAction(UIAction { [weak self] _ in self?.close() }, for: .touchUpInside)
        doneButton.heightAnchor.constraint(greaterThanOrEqualToConstant: 44).isActive = true

        let stack = UIStackView(arrangedSubviews: [titleLabel, messageLabel, progressView, serverStack, doneButton])
        stack.axis = .vertical
        stack.spacing = 12
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 20),
            stack.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 20),
            stack.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -20),
        ])
        start()
    }

    private func start() {
        let servers = L4ShareStore.connectedServers
        guard !servers.isEmpty else {
            return show("Open L4 and sign in to a Server first. Then you can share here.")
        }
        guard let provider = (extensionContext?.inputItems as? [NSExtensionItem])?.flatMap({ $0.attachments ?? [] }).first(where: {
            $0.hasItemConformingToTypeIdentifier(UTType.image.identifier) || $0.hasItemConformingToTypeIdentifier(UTType.movie.identifier)
        }) else {
            return show("L4 takes a screenshot or a screen recording.")
        }
        show("Getting the file…")
        receive(provider) { [weak self] received in
            guard let self else { return }
            guard let received else { return self.show("Could not read this file.") }
            self.file = received
            self.handOff(to: servers)
        }
    }

    /// Copied into the shared folder: the system deletes the original when this sheet closes.
    private func receive(_ provider: NSItemProvider, completion: @escaping ((url: URL, name: String)?) -> Void) {
        let type = provider.hasItemConformingToTypeIdentifier(UTType.movie.identifier) ? UTType.movie : UTType.image
        func deliver(_ result: (url: URL, name: String)?) { DispatchQueue.main.async { completion(result) } }
        guard let folder = L4ShareStore.uploadFolder else { return deliver(nil) }
        let target = folder.appendingPathComponent(UUID().uuidString)
        provider.loadFileRepresentation(forTypeIdentifier: type.identifier) { url, _ in
            if let url, type == .image, !Self.isSendableImage(url), let png = UIImage(contentsOfFile: url.path)?.pngData(), (try? png.write(to: target)) != nil {
                return deliver((target, url.deletingPathExtension().lastPathComponent + ".png"))
            }
            if let url, (try? FileManager.default.copyItem(at: url, to: target)) != nil {
                return deliver((target, url.lastPathComponent))
            }
            // A screenshot edited in the share sheet can arrive only as an image in memory.
            _ = provider.loadDataRepresentation(forTypeIdentifier: type.identifier) { data, _ in
                guard let png = data.flatMap({ UIImage(data: $0)?.pngData() }), (try? png.write(to: target)) != nil else { return deliver(nil) }
                deliver((target, "screenshot.png"))
            }
        }
    }

    /// PNG, JPEG, GIF or WebP, which a Server takes as they are; a HEIC photo gets converted.
    private static func isSendableImage(_ url: URL) -> Bool {
        guard let handle = try? FileHandle(forReadingFrom: url), let head = try? handle.read(upToCount: 12) else { return false }
        try? handle.close()
        let bytes = [UInt8](head)
        return bytes.starts(with: [0x89, 0x50, 0x4E, 0x47]) || bytes.starts(with: [0xFF, 0xD8, 0xFF])
            || bytes.starts(with: [0x47, 0x49, 0x46]) || (bytes.starts(with: [0x52, 0x49, 0x46, 0x46]) && Array(bytes.dropFirst(8)) == [0x57, 0x45, 0x42, 0x50])
    }

    private func chooseServer(_ servers: [L4ShareServer]) {
        show("Which Server?")
        for server in servers {
            let button = UIButton(type: .system)
            button.setTitle(server.name, for: .normal)
            button.heightAnchor.constraint(greaterThanOrEqualToConstant: 44).isActive = true
            button.addAction(UIAction { [weak self] _ in self?.send(to: server) }, for: .touchUpInside)
            serverStack.addArrangedSubview(button)
        }
    }

    private func send(to server: L4ShareServer) {
        serverStack.arrangedSubviews.forEach { $0.removeFromSuperview() }
        guard let file, let token = L4ShareStore.key(for: server.origin) else {
            return show("Open this Server in L4 and sign in, then share again.")
        }
        titleLabel.text = "Sending to \(server.name)"
        show("You can close this. It keeps sending.")
        progressView.isHidden = false
        doneButton.setTitle("Close", for: .normal)
        let uploader = L4ShareUploader()
        uploader.onProgress = { [weak self] in self?.progressView.progress = Float($0) }
        uploader.onFinish = { [weak self] result in
            guard let self else { return }
            self.progressView.isHidden = true
            self.doneButton.setTitle("Done", for: .normal)
            switch result {
            case .created:
                self.titleLabel.text = "Task created"
                self.show("Open L4 to mark it, or leave it for later.")
            case .failed(let message):
                self.titleLabel.text = "Not sent"
                self.show(message)
            }
        }
        self.uploader = uploader
        uploader.upload(file: file.url, name: file.name, server: server, token: token)
    }

    /// Goes straight to the app, where the file is marked and sent. If the app won't open, this
    /// sheet sends the file itself, and marking waits for later.
    private func handOff(to servers: [L4ShareServer]) {
        guard let file else { return }
        L4ShareStore.setPendingUpload(L4PendingUpload(file: file.url.lastPathComponent, name: file.name, origin: servers.first?.origin))
        var settled = false
        let settle: (Bool) -> Void = { [weak self] opened in
            guard !settled, let self else { return }
            settled = true
            if opened {
                self.handedOff = true
                self.extensionContext?.completeRequest(returningItems: nil)
                return
            }
            L4ShareStore.clearPendingUpload()
            if servers.count == 1 { self.send(to: servers[0]) } else { self.chooseServer(servers) }
        }
        openApp(settle)
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { settle(false) }
    }

    /// Apple offers an extension no call for this, so it reaches the host's UIApplication along the responder chain.
    private func openApp(_ completion: @escaping (Bool) -> Void) {
        guard let url = URL(string: "llll://mark") else { return completion(false) }
        let selector = sel_registerName("openURL:options:completionHandler:")
        let done: @convention(block) (Bool) -> Void = { opened in DispatchQueue.main.async { completion(opened) } }
        typealias Open = @convention(c) (AnyObject, Selector, NSURL, NSDictionary, @convention(block) (Bool) -> Void) -> Void
        var responder: UIResponder? = self
        while let current = responder {
            if current is UIApplication, current.responds(to: selector) {
                unsafeBitCast(current.method(for: selector), to: Open.self)(current, selector, url as NSURL, [:], done)
                return
            }
            responder = current.next
        }
        completion(false)
    }

    private func show(_ message: String) { messageLabel.text = message }

    private func close() {
        // Nothing was sent, so nothing else will clean this copy up.
        if uploader == nil, !handedOff, let file { try? FileManager.default.removeItem(at: file.url) }
        extensionContext?.completeRequest(returningItems: nil)
    }
}
