import UIKit
import WebKit
import Capacitor

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        window = UIWindow(windowScene: windowScene)
        window?.rootViewController = L4BridgeViewController()
        window?.makeKeyAndVisible()

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
    }

    // A file just shared opens the app's own marking page. At launch the Server list asks for it
    // instead, so it can't race the list reopening the last Server.
    func sceneDidBecomeActive(_ scene: UIScene) {
        guard L4SharePlugin.listIsUp, let controller = window?.rootViewController as? L4BridgeViewController else { return }
        if controller.openPendingShare() { return }
        if let editor = L4ShareStore.takePendingEditor() { controller.webView?.load(URLRequest(url: editor)) }
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }
}

/// Opens each Server's own Client from the bundled Server list and injects the
/// native notification bridge into it. Settings in the Client returns to the list;
/// every swipe belongs to the Client.
class L4BridgeViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        super.capacitorDidLoad()
        bridge?.registerPluginInstance(L4SharePlugin())
        guard let webView = webView else { return }
        NotificationCenter.default.addObserver(self, selector: #selector(keyboardWillChangeFrame(_:)), name: UIResponder.keyboardWillChangeFrameNotification, object: nil)
        // WebKit scrolls the page up to show a focused input before the Client has laid out at its new height,
        // which throws the header off screen. A Client scrolls inside itself, so it never needs this outer offset.
        offsetObservation = webView.scrollView.observe(\.contentOffset) { [weak webView] scrollView, _ in
            guard scrollView.contentOffset != .zero, webView?.url?.scheme?.hasPrefix("http") == true else { return }
            scrollView.contentOffset = .zero
        }
        urlObservation = webView.observe(\.url) { [weak self] _, _ in self?.serverChanged() }
        if let url = Bundle.main.url(forResource: "native-bridge", withExtension: "js", subdirectory: "public"),
           let source = try? String(contentsOf: url, encoding: .utf8) {
            webView.configuration.userContentController.addUserScript(
                WKUserScript(source: source, injectionTime: .atDocumentStart, forMainFrameOnly: true)
            )
        }
    }

    /// Fits the WebView above the keyboard in step with its animation, so a Client's header and focused input stay on screen.
    @objc private func keyboardWillChangeFrame(_ notification: Notification) {
        guard let webView = webView, let container = webView.superview,
              let end = (notification.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? NSValue)?.cgRectValue else { return }
        let top = container.convert(end, from: nil).minY
        keyboardTop = top
        let duration = notification.userInfo?[UIResponder.keyboardAnimationDurationUserInfoKey] as? Double ?? 0.25
        let curve = notification.userInfo?[UIResponder.keyboardAnimationCurveUserInfoKey] as? UInt ?? 7
        UIView.animate(withDuration: duration, delay: 0, options: [UIView.AnimationOptions(rawValue: curve << 16), .beginFromCurrentState]) {
            self.layoutPages()
            container.layoutIfNeeded()
        }
    }

    private var offsetObservation: NSKeyValueObservation?
    private var urlObservation: NSKeyValueObservation?
    private var keyboardTop: CGFloat?
    private var railView: WKWebView?
    private var railWanted = false
    private var railServer: String?
    private let railWidth: CGFloat = 72

    /// The rail sits in its own WebView at the app's own address, so a Server's page can't reach it or the list it reads.
    /// Capacitor makes the page this controller's own view, so it has somewhere to put a neighbour only once it is in the window.
    private func installRail() {
        guard railView == nil, let webView = webView, let container = webView.superview,
              let start = bridge?.config.appStartServerURL, let scheme = start.scheme else { return }
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = webView.configuration.websiteDataStore
        configuration.setURLSchemeHandler(webView.configuration.urlSchemeHandler(forURLScheme: scheme), forURLScheme: scheme)
        configuration.userContentController.add(L4RailMessages(controller: self), name: "l4Rail")
        let rail = WKWebView(frame: .zero, configuration: configuration)
        rail.isOpaque = false
        rail.backgroundColor = .black
        rail.scrollView.backgroundColor = .black
        rail.scrollView.contentInsetAdjustmentBehavior = .never
        rail.isHidden = true
        container.addSubview(rail)
        rail.load(URLRequest(url: start.appendingPathComponent("rail.html")))
        railView = rail
    }

    private func serverOrigin() -> String? {
        guard let url = webView?.url, url.scheme?.hasPrefix("http") == true, let scheme = url.scheme, let host = url.host else { return nil }
        return "\(scheme)://\(host)" + (url.port.map { ":\($0)" } ?? "")
    }

    private func serverChanged() {
        let origin = serverOrigin()
        guard origin != railServer else { return }
        railServer = origin
        // A new page says for itself whether it has room.
        railWanted = false
        tellRailActive()
        layoutPages()
    }

    private func tellRailActive() {
        let value = railServer.flatMap { try? JSONSerialization.data(withJSONObject: $0, options: .fragmentsAllowed) }.flatMap { String(data: $0, encoding: .utf8) } ?? "null"
        railView?.evaluateJavaScript("window.__L4_RAIL__?.setActive(\(value))")
    }

    func railMessage(_ body: String) {
        guard let data = body.data(using: .utf8), let message = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
        switch message["type"] as? String {
        case "ready": tellRailActive()
        case "list": showServers()
        case "open":
            guard let origin = message["origin"] as? String, L4ShareStore.servers.contains(where: { $0.origin == origin }),
                  let url = URL(string: origin + "/") else { return }
            webView?.load(URLRequest(url: url))
        default: break
        }
    }

    func setRail(wanted: Bool) {
        railWanted = wanted
        UIView.animate(withDuration: 0.2) { self.layoutPages() }
    }

    private func layoutPages() {
        guard let webView = webView, let container = webView.superview else { return }
        installRail()
        let bounds = container.bounds
        let show = railView != nil && railServer != nil && (railWanted || traitCollection.horizontalSizeClass != .compact)
        let left = show ? railWidth : 0
        let height = min(bounds.height, max(0, keyboardTop ?? bounds.height))
        let frame = CGRect(x: left, y: 0, width: bounds.width - left, height: height)
        if webView.frame != frame { webView.frame = frame }
        railView?.frame = CGRect(x: 0, y: 0, width: railWidth, height: bounds.height)
        railView?.isHidden = !show
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        layoutPages()
    }

    private var shareUploaders: [L4ShareUploader] = []

    /// Sends in the background: the person is already somewhere else in the app, so only a problem reaches them.
    func send(file: URL, name: String, server: L4ShareServer, token: String, marks: (file: URL, contentType: String)) {
        let uploader = L4ShareUploader()
        shareUploaders.append(uploader)
        uploader.upload(file: file, name: name, server: server, token: token, marks: marks)
    }

    /// False when no file is waiting, or the page already shows it.
    func openPendingShare() -> Bool {
        guard let upload = L4ShareStore.pendingUpload, let start = bridge?.config.appStartServerURL else { return false }
        if shownShare == upload.file, webView?.url?.lastPathComponent == "mark.html" { return true }
        shownShare = upload.file
        webView?.load(URLRequest(url: start.appendingPathComponent("mark.html")))
        return true
    }
    private var shownShare: String?

    func showServers() {
        guard let webView = webView,
              let list = bridge?.config.appStartServerURL,
              webView.url?.scheme != list.scheme else { return }
        // The fragment tells the list not to reopen the last Server.
        var components = URLComponents(url: list, resolvingAgainstBaseURL: false)
        components?.fragment = "servers"
        if let url = components?.url { webView.load(URLRequest(url: url)) }
    }
}

/// Holds the controller weakly: a content controller keeps its handlers for as long as it lives.
private class L4RailMessages: NSObject, WKScriptMessageHandler {
    private weak var controller: L4BridgeViewController?
    init(controller: L4BridgeViewController) { self.controller = controller }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame, let body = message.body as? String else { return }
        controller?.railMessage(body)
    }
}
