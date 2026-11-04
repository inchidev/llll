import Capacitor
import Foundation

/// Lets the bundled Server list and each Server's page fill what the Share
/// Extension reads. A page only ever reaches its own origin's entry.
@objc(L4SharePlugin)
public class L4SharePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "L4SharePlugin"
    public let jsName = "L4Share"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "syncServers", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "serverNeedingKey", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "saveKey", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "takePendingEditor", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pendingShare", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "limits", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "transcribe", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "sendMarked", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancelShare", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "showServers", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setRail", returnType: CAPPluginReturnPromise),
    ]
    /// Set once the list asks: until then a launch leaves the first page to it.
    static var listIsUp = false

    private func onPage(_ call: CAPPluginCall, _ body: @escaping (URL) -> Void) {
        DispatchQueue.main.async {
            guard let url = self.bridge?.webView?.url else { return call.reject("No page") }
            body(url)
        }
    }

    private func isBundledList(_ url: URL) -> Bool {
        guard let start = bridge?.config.appStartServerURL else { return false }
        return url.scheme == start.scheme && url.host == start.host
    }

    private func origin(of url: URL) -> String? {
        guard let scheme = url.scheme, let host = url.host else { return nil }
        return "\(scheme)://\(host)" + (url.port.map { ":\($0)" } ?? "")
    }

    @objc func syncServers(_ call: CAPPluginCall) {
        onPage(call) { url in
            guard self.isBundledList(url) else { return call.reject("Only the Server list can do this") }
            let servers = (call.getArray("servers") ?? []).compactMap { item -> L4ShareServer? in
                guard let item = item as? [String: Any], let id = item["id"] as? String,
                      let origin = item["origin"] as? String, let name = item["name"] as? String else { return nil }
                return L4ShareServer(id: id, origin: origin, name: name)
            }
            L4ShareStore.setServers(servers)
            call.resolve()
        }
    }

    @objc func serverNeedingKey(_ call: CAPPluginCall) {
        onPage(call) { url in
            guard let origin = self.origin(of: url),
                  let server = L4ShareStore.servers.first(where: { $0.origin == origin }),
                  L4ShareStore.key(for: origin) == nil else { return call.resolve([:]) }
            call.resolve(["serverId": server.id])
        }
    }

    @objc func saveKey(_ call: CAPPluginCall) {
        onPage(call) { url in
            guard let origin = self.origin(of: url), L4ShareStore.servers.contains(where: { $0.origin == origin }),
                  let token = call.getString("token") else { return call.reject("This page isn’t a Server on this device") }
            L4ShareStore.saveKey(token, for: origin) ? call.resolve() : call.reject("Could not save the key")
        }
    }

    @objc func takePendingEditor(_ call: CAPPluginCall) {
        onPage(call) { url in
            guard self.isBundledList(url) else { return call.reject("Only the Server list can do this") }
            Self.listIsUp = true
            if L4ShareStore.pendingUpload != nil { return call.resolve(["url": "mark.html"]) }
            if let editor = L4ShareStore.takePendingEditor() { call.resolve(["url": editor.absoluteString]) }
            else { call.resolve([:]) }
        }
    }

    private func onMarkPage(_ call: CAPPluginCall, _ body: @escaping () -> Void) {
        onPage(call) { url in
            guard self.isBundledList(url) else { return call.reject("Only the marking page can do this") }
            body()
        }
    }

    @objc func pendingShare(_ call: CAPPluginCall) {
        onMarkPage(call) {
            guard let upload = L4ShareStore.pendingUpload, let file = L4ShareStore.uploadFolder?.appendingPathComponent(upload.file),
                  FileManager.default.fileExists(atPath: file.path) else { return call.resolve([:]) }
            let servers = L4ShareStore.connectedServers.map { ["origin": $0.origin, "name": $0.name] }
            call.resolve(["path": file.path, "name": upload.name, "origin": L4ShareStore.lastOrigin ?? upload.origin ?? "", "servers": servers])
        }
    }

    /// A device-key request for the marking page, which can't reach a Server itself across origins.
    private func keyed(_ call: CAPPluginCall, path: String, query: [URLQueryItem] = [], method: String, body: Data? = nil, contentType: String? = nil) {
        guard let origin = call.getString("origin"), L4ShareStore.servers.contains(where: { $0.origin == origin }), let token = L4ShareStore.key(for: origin),
              var components = URLComponents(string: origin + path) else { return call.reject("Open this Server in L4 and sign in first.") }
        components.queryItems = [URLQueryItem(name: "key", value: token)] + query
        guard let url = components.url else { return call.reject("This Server’s address doesn’t work.") }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.httpBody = body
        if let contentType { request.setValue(contentType, forHTTPHeaderField: "Content-Type") }
        URLSession.shared.dataTask(with: request) { data, response, _ in
            let text = data.flatMap { String(data: $0, encoding: .utf8) } ?? ""
            guard let status = (response as? HTTPURLResponse)?.statusCode else { return call.reject("Check your connection and try again.") }
            if status < 400 { return call.resolve(["json": text]) }
            let message = (data.flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any]).flatMap { $0["error"] as? [String: Any] }?["message"] as? String
            call.reject(message ?? "That did not work.")
        }.resume()
    }

    @objc func limits(_ call: CAPPluginCall) {
        onMarkPage(call) { self.keyed(call, path: "/api/recordings/limits", method: "GET") }
    }

    @objc func transcribe(_ call: CAPPluginCall) {
        onMarkPage(call) {
            guard let wav = call.getString("wav").flatMap({ Data(base64Encoded: $0) }) else { return call.reject("No audio") }
            self.keyed(call, path: "/api/recordings/voice", query: [URLQueryItem(name: "at", value: String(call.getDouble("at") ?? 0))], method: "POST", body: wav, contentType: "audio/wav")
        }
    }

    @objc func sendMarked(_ call: CAPPluginCall) {
        onMarkPage(call) {
            guard let upload = L4ShareStore.pendingUpload, let folder = L4ShareStore.uploadFolder, let origin = call.getString("origin"),
                  let server = L4ShareStore.servers.first(where: { $0.origin == origin }), let token = L4ShareStore.key(for: origin),
                  let contentType = call.getString("contentType"), let body = call.getString("body").flatMap({ Data(base64Encoded: $0) }) else {
                return call.reject("Open this Server in L4 and sign in first.")
            }
            let marks = folder.appendingPathComponent("\(UUID().uuidString).marks")
            guard (try? body.write(to: marks)) != nil else { return call.reject("Could not save the marks.") }
            (self.bridge?.viewController as? L4BridgeViewController)?.send(file: folder.appendingPathComponent(upload.file), name: upload.name, server: server, token: token, marks: (marks, contentType))
            L4ShareStore.clearPendingUpload()
            call.resolve()
        }
    }

    @objc func showServers(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            (self.bridge?.viewController as? L4BridgeViewController)?.showServers()
            call.resolve()
        }
    }

    @objc func setRail(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            (self.bridge?.viewController as? L4BridgeViewController)?.setRail(wanted: call.getBool("visible") ?? false)
            call.resolve()
        }
    }

    @objc func cancelShare(_ call: CAPPluginCall) {
        onMarkPage(call) {
            if let upload = L4ShareStore.pendingUpload, let file = L4ShareStore.uploadFolder?.appendingPathComponent(upload.file) { try? FileManager.default.removeItem(at: file) }
            L4ShareStore.clearPendingUpload()
            call.resolve()
        }
    }
}
