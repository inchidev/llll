import Foundation
import Security
import UserNotifications

/// What the app and its Share Extension both read: this device's Servers, a
/// device key for each, and the marking page of a recording just sent.
struct L4ShareServer: Codable {
    let id: String
    let origin: String
    let name: String
}

/// A file the Share Extension handed to the app to mark and send.
struct L4PendingUpload: Codable {
    let file: String
    let name: String
    let origin: String?
}

enum L4ShareStore {
    static let group = Bundle.main.object(forInfoDictionaryKey: "L4AppGroup") as? String ?? ""
    private static let serversKey = "servers"
    private static let lastKey = "last-origin"
    private static let editorKey = "pending-editor"
    private static let editorAtKey = "pending-editor-at"
    private static let uploadKey = "pending-upload"
    private static let keychainService = "gg.llll.recording-key"
    /// Long enough to send a recording and open the app, short enough not to surprise anyone later.
    private static let editorLifetime: TimeInterval = 15 * 60

    private static var defaults: UserDefaults? { UserDefaults(suiteName: group) }

    static var servers: [L4ShareServer] {
        guard let data = defaults?.data(forKey: serversKey) else { return [] }
        return (try? JSONDecoder().decode([L4ShareServer].self, from: data)) ?? []
    }

    /// Servers that can receive a file now, the last one used first.
    static var connectedServers: [L4ShareServer] {
        let last = defaults?.string(forKey: lastKey)
        return servers.filter { key(for: $0.origin) != nil }.sorted { $0.origin == last && $1.origin != last }
    }

    static func setServers(_ servers: [L4ShareServer]) {
        let kept = Set(servers.map(\.origin))
        for server in self.servers where !kept.contains(server.origin) { deleteKey(for: server.origin) }
        defaults?.set(try? JSONEncoder().encode(servers), forKey: serversKey)
    }

    static func rememberLast(_ origin: String) { defaults?.set(origin, forKey: lastKey) }

    static func setPendingEditor(_ url: String) {
        defaults?.set(url, forKey: editorKey)
        defaults?.set(Date().timeIntervalSince1970, forKey: editorAtKey)
    }

    static func takePendingEditor() -> URL? {
        guard let value = defaults?.string(forKey: editorKey) else { return nil }
        let age = Date().timeIntervalSince1970 - (defaults?.double(forKey: editorAtKey) ?? 0)
        defaults?.removeObject(forKey: editorKey)
        defaults?.removeObject(forKey: editorAtKey)
        return age < editorLifetime ? URL(string: value) : nil
    }

    static func setPendingUpload(_ upload: L4PendingUpload) {
        defaults?.set(try? JSONEncoder().encode(upload), forKey: uploadKey)
        defaults?.synchronize()
    }

    static var pendingUpload: L4PendingUpload? {
        defaults?.synchronize()
        return defaults?.data(forKey: uploadKey).flatMap { try? JSONDecoder().decode(L4PendingUpload.self, from: $0) }
    }

    static func clearPendingUpload() {
        defaults?.removeObject(forKey: uploadKey)
        defaults?.synchronize()
    }

    static var lastOrigin: String? { defaults?.string(forKey: lastKey) }

    private static func keyQuery(_ origin: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: origin,
            kSecAttrAccessGroup as String: group,
        ]
    }

    static func key(for origin: String) -> String? {
        var query = keyQuery(origin)
        query[kSecReturnData as String] = true
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess, let data = item as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    @discardableResult
    static func saveKey(_ token: String, for origin: String) -> Bool {
        deleteKey(for: origin)
        var query = keyQuery(origin)
        query[kSecValueData as String] = Data(token.utf8)
        // The extension runs while the phone may be locked again, after the first unlock.
        query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        return SecItemAdd(query as CFDictionary, nil) == errSecSuccess
    }

    static func deleteKey(for origin: String) { SecItemDelete(keyQuery(origin) as CFDictionary) }

    static var uploadFolder: URL? {
        guard let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group) else { return nil }
        let folder = container.appendingPathComponent("uploads", isDirectory: true)
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        return folder
    }
}

enum L4ShareResult {
    case created
    case failed(String)
}

/// Sends one file to `/api/recordings` in a background session, so it finishes
/// even when the share sheet is closed; the app picks up the session then.
final class L4ShareUploader: NSObject, URLSessionDataDelegate {
    private struct Job: Codable {
        let origin: String
        let file: String
        /// Marks and frames to send once the file has made a Task.
        var marksFile: String?
        var marksType: String?
        var isMarks = false
    }

    var onProgress: ((Double) -> Void)?
    var onFinish: ((L4ShareResult) -> Void)?
    var onEventsFinished: (() -> Void)?
    private var session: URLSession!
    private var bodies: [Int: Data] = [:]

    init(identifier: String = "gg.llll.share.\(UUID().uuidString)") {
        super.init()
        let configuration = URLSessionConfiguration.background(withIdentifier: identifier)
        configuration.sharedContainerIdentifier = L4ShareStore.group
        configuration.sessionSendsLaunchEvents = true
        session = URLSession(configuration: configuration, delegate: self, delegateQueue: .main)
    }

    func upload(file: URL, name: String, server: L4ShareServer, token: String, marks: (file: URL, contentType: String)? = nil) {
        var components = URLComponents(string: server.origin + "/api/recordings")
        components?.queryItems = [URLQueryItem(name: "key", value: token), URLQueryItem(name: "name", value: name)]
        guard let url = components?.url else { return finish(.failed("This Server’s address doesn’t work."), file: file) }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
        let task = session.uploadTask(with: request, fromFile: file)
        start(task, Job(origin: server.origin, file: file.lastPathComponent, marksFile: marks?.file.lastPathComponent, marksType: marks?.contentType))
    }

    private func start(_ task: URLSessionUploadTask, _ job: Job) {
        task.taskDescription = (try? JSONEncoder().encode(job)).flatMap { String(data: $0, encoding: .utf8) }
        task.resume()
    }

    /// The Task exists now: its marks and frames follow in a request of their own.
    private func sendMarks(_ job: Job, taskId: String, marksFile: String, contentType: String) {
        guard let token = L4ShareStore.key(for: job.origin), let file = L4ShareStore.uploadFolder?.appendingPathComponent(marksFile),
              var components = URLComponents(string: "\(job.origin)/api/recordings/\(taskId)/marks") else {
            return finish(.failed("The recording was sent, but not its marks."), file: nil)
        }
        components.queryItems = [URLQueryItem(name: "key", value: token)]
        guard let url = components.url else { return finish(.failed("The recording was sent, but not its marks."), file: nil) }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue(contentType, forHTTPHeaderField: "Content-Type")
        start(session.uploadTask(with: request, fromFile: file), Job(origin: job.origin, file: marksFile, isMarks: true))
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didSendBodyData bytesSent: Int64, totalBytesSent: Int64, totalBytesExpectedToSend: Int64) {
        if totalBytesExpectedToSend > 0 { onProgress?(Double(totalBytesSent) / Double(totalBytesExpectedToSend)) }
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        bodies[dataTask.taskIdentifier, default: Data()].append(data)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        let job = task.taskDescription.flatMap { try? JSONDecoder().decode(Job.self, from: Data($0.utf8)) }
        let file = job.flatMap { job in L4ShareStore.uploadFolder?.appendingPathComponent(job.file) }
        let body = bodies.removeValue(forKey: task.taskIdentifier) ?? Data()
        guard error == nil, let job else {
            return finish(.failed("The upload stopped. Check your connection and try again."), file: file)
        }
        if job.isMarks {
            let status = (task.response as? HTTPURLResponse)?.statusCode ?? 0
            return finish(status < 400 ? .created : .failed("The recording was sent, but not its marks. Open its Task to mark it."), file: file)
        }
        // The answer is one address: the marking page, or a page saying why the file was refused.
        let answer = String(data: body, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let problem = URLComponents(string: answer).flatMap { $0.path == "/recording-problem" ? $0.queryItems?.first(where: { $0.name == "why" })?.value ?? "failed" : nil }
        if problem == "unauthorized" {
            L4ShareStore.deleteKey(for: job.origin)
            return finish(.failed("This device needs to connect to this Server again. Open the Server in L4, wait until it has loaded, then share again. There’s nothing to copy or paste."), file: file)
        }
        // Only ever open a page of the Server the file went to.
        guard problem == nil, answer.hasPrefix(job.origin + "/") else {
            return finish(.failed(problem == "too_large" ? "That file is too large." : "The Server didn’t take this file."), file: file)
        }
        L4ShareStore.rememberLast(job.origin)
        if let marksFile = job.marksFile, let contentType = job.marksType, let taskId = URL(string: answer)?.pathComponents.last {
            if let file { try? FileManager.default.removeItem(at: file) }
            return sendMarks(job, taskId: taskId, marksFile: marksFile, contentType: contentType)
        }
        L4ShareStore.setPendingEditor(answer)
        Self.notify(title: "Task created", body: "Open L4 to mark the recording.")
        finish(.created, file: file)
    }

    func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
        onEventsFinished?()
    }

    private func finish(_ result: L4ShareResult, file: URL?) {
        if let file { try? FileManager.default.removeItem(at: file) }
        // Nobody is looking at the app's own uploads, so a problem has to come to them.
        if case .failed(let message) = result, onFinish == nil { Self.notify(title: "Not sent", body: message) }
        onFinish?(result)
    }

    private static func notify(title: String, body: String) {
        let center = UNUserNotificationCenter.current()
        center.getNotificationSettings { settings in
            guard settings.authorizationStatus == .authorized else { return }
            let content = UNMutableNotificationContent()
            content.title = title
            content.body = body
            center.add(UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil))
        }
    }
}
