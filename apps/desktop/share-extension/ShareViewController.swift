import Cocoa
import UniformTypeIdentifiers

/// L4 in the Share menu: keeps a copy of the file and hands it to the app, which
/// asks where it goes and sends it. Being sandboxed, it holds no key and no network.
final class ShareViewController: NSViewController {
    override func loadView() {
        view = NSView(frame: NSRect(x: 0, y: 0, width: 280, height: 80))
        let label = NSTextField(labelWithString: "Sending to L4…")
        label.frame = NSRect(x: 20, y: 30, width: 240, height: 20)
        view.addSubview(label)
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        let providers = (extensionContext?.inputItems as? [NSExtensionItem])?.flatMap { $0.attachments ?? [] } ?? []
        guard let provider = providers.first(where: {
            $0.hasItemConformingToTypeIdentifier(UTType.image.identifier) || $0.hasItemConformingToTypeIdentifier(UTType.movie.identifier)
        }) else { return finish() }
        let type = provider.hasItemConformingToTypeIdentifier(UTType.movie.identifier) ? UTType.movie : UTType.image
        provider.loadFileRepresentation(forTypeIdentifier: type.identifier) { url, _ in
            let name = url.flatMap { Self.keep($0, isImage: type == .image, suggestedName: provider.suggestedName) }
            DispatchQueue.main.async {
                if let name, var link = URLComponents(string: "llll://share") {
                    link.queryItems = [URLQueryItem(name: "file", value: name)]
                    if let target = link.url { NSWorkspace.shared.open(target) }
                }
                self.finish()
            }
        }
    }

    private static func keep(_ url: URL, isImage: Bool, suggestedName: String?) -> String? {
        guard let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else { return nil }
        let folder = support.appendingPathComponent("share", isDirectory: true)
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        removeAbandoned(in: folder)
        // The system names its copy after the file's type, so the real name comes from the provider.
        let base = suggestedName ?? url.deletingPathExtension().lastPathComponent
        let id = UUID().uuidString
        if isImage, !isSendableImage(url), let png = pngData(from: url) {
            let name = "\(id)-\((base as NSString).deletingPathExtension).png"
            return (try? png.write(to: folder.appendingPathComponent(name))) != nil ? name : nil
        }
        let shown = url.pathExtension.isEmpty || base.hasSuffix(".\(url.pathExtension)") ? base : "\(base).\(url.pathExtension)"
        let name = "\(id)-\(shown)"
        return (try? FileManager.default.copyItem(at: url, to: folder.appendingPathComponent(name))) != nil ? name : nil
    }

    /// PNG, JPEG, GIF or WebP, which a Server takes as they are.
    private static func isSendableImage(_ url: URL) -> Bool {
        guard let handle = try? FileHandle(forReadingFrom: url), let head = try? handle.read(upToCount: 12) else { return false }
        try? handle.close()
        let bytes = [UInt8](head)
        return bytes.starts(with: [0x89, 0x50, 0x4E, 0x47]) || bytes.starts(with: [0xFF, 0xD8, 0xFF])
            || bytes.starts(with: [0x47, 0x49, 0x46]) || (bytes.starts(with: [0x52, 0x49, 0x46, 0x46]) && Array(bytes.dropFirst(8)) == [0x57, 0x45, 0x42, 0x50])
    }

    /// The screenshot preview shares an archived image rather than a file; HEIC and TIFF also land here.
    private static func pngData(from url: URL) -> Data? {
        let archived = (try? Data(contentsOf: url)).flatMap { try? NSKeyedUnarchiver.unarchivedObject(ofClass: NSImage.self, from: $0) }
        guard let tiff = (archived ?? NSImage(contentsOf: url))?.tiffRepresentation else { return nil }
        return NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:])
    }

    /// A file nobody chose a Server for shouldn't stay forever.
    private static func removeAbandoned(in folder: URL) {
        let day = Date().addingTimeInterval(-24 * 60 * 60)
        for file in (try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: [.contentModificationDateKey])) ?? [] {
            if let changed = try? file.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate, changed < day {
                try? FileManager.default.removeItem(at: file)
            }
        }
    }

    private func finish() { extensionContext?.completeRequest(returningItems: nil) }
}
