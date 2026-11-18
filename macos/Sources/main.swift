import AppKit
import Darwin
import WebKit

/// write() su un client già chiuso non deve terminare il processo.
private func ignorePipe(_: Int32) {}

/// Server statico solo su 127.0.0.1:5173. Il socket non è in ascolto sulle altre interfacce.
/// La query dell'URL non viene toccata: `/?code=…&state=…` riceve index.html senza redirect,
/// così la WebView conserva l'URI di ritorno di Spotify.
final class StaticServer: Sendable {
    private let root: URL
    private let ioQueue = DispatchQueue(label: "org.demox18.scaffale.http", attributes: .concurrent)
    private let marker = Data([13, 10, 13, 10])

    init(root: URL) {
        self.root = root.standardizedFileURL
    }

    func start() throws {
        _ = Darwin.signal(SIGPIPE, ignorePipe)
        let fd = try Self.bindLoopback()
        DispatchQueue.global(qos: .userInitiated).async { [self] in
            self.acceptLoop(fd)
        }
    }

    private static func bindLoopback() throws -> Int32 {
        let fd = Darwin.socket(AF_INET, SOCK_STREAM, 0)
        guard fd >= 0 else { throw StaticServerError.failed("socket non disponibile") }

        var reuse: Int32 = 1
        _ = Darwin.setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &reuse, socklen_t(MemoryLayout<Int32>.size))

        var address = sockaddr_in()
        address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        address.sin_family = sa_family_t(AF_INET)
        address.sin_port = UInt16(5173).bigEndian
        let parsed = "127.0.0.1".withCString { Darwin.inet_pton(AF_INET, $0, &address.sin_addr) }
        guard parsed == 1 else {
            Darwin.close(fd)
            throw StaticServerError.failed("indirizzo 127.0.0.1 non valido")
        }

        let bound = withUnsafePointer(to: &address) { pointer -> Int32 in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { sock in
                Darwin.bind(fd, sock, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        if bound != 0 {
            let error = errno
            Darwin.close(fd)
            if error == EADDRINUSE { throw StaticServerError.addressInUse }
            throw StaticServerError.failed(String(cString: strerror(error)))
        }
        if Darwin.listen(fd, 32) != 0 {
            let error = errno
            Darwin.close(fd)
            throw StaticServerError.failed(String(cString: strerror(error)))
        }
        return fd
    }

    private func acceptLoop(_ listenFD: Int32) {
        // Il socket è legato solo a 127.0.0.1: chi si connette è già sul loopback.
        while true {
            let client = Darwin.accept(listenFD, nil, nil)
            if client < 0 {
                if errno == EINTR { continue }
                return
            }
            ioQueue.async { [self] in
                self.serve(client)
            }
        }
    }

    private func serve(_ client: Int32) {
        defer { Darwin.close(client) }
        var noSignal: Int32 = 1
        _ = Darwin.setsockopt(client, SOL_SOCKET, SO_NOSIGPIPE, &noSignal, socklen_t(MemoryLayout<Int32>.size))
        var timeout = timeval()
        timeout.tv_sec = 10
        timeout.tv_usec = 0
        let timeoutLength = socklen_t(MemoryLayout<timeval>.size)
        _ = Darwin.setsockopt(client, SOL_SOCKET, SO_RCVTIMEO, &timeout, timeoutLength)
        _ = Darwin.setsockopt(client, SOL_SOCKET, SO_SNDTIMEO, &timeout, timeoutLength)

        guard let incoming = readHeader(client),
              let headerEnd = incoming.range(of: marker),
              let header = String(data: incoming.subdata(in: 0..<headerEnd.lowerBound), encoding: .utf8)
        else { return }

        let requestLine = header.split(separator: "\r\n", maxSplits: 1, omittingEmptySubsequences: false).first.map(String.init) ?? ""
        let parts = requestLine.split(separator: " ")
        guard parts.count >= 2 else {
            writeAll(client, textResponse(400, "Bad Request", "Richiesta non valida.\n", headOnly: false))
            return
        }
        let method = String(parts[0]).uppercased()
        let target = String(parts[1])
        guard method == "GET" || method == "HEAD" else {
            writeAll(client, textResponse(405, "Method Not Allowed", "Metodo non consentito.\n", headOnly: false, extra: "Allow: GET, HEAD\r\n"))
            return
        }
        let headOnly = method == "HEAD"
        switch resolve(target) {
        case .badRequest:
            writeAll(client, textResponse(400, "Bad Request", "Richiesta non valida.\n", headOnly: headOnly))
        case .notFound:
            writeAll(client, textResponse(404, "Not Found", "File non trovato.\n", headOnly: headOnly))
        case .file(let url):
            guard let body = try? Data(contentsOf: url) else {
                writeAll(client, textResponse(500, "Internal Server Error", "Non riesco a leggere il file.\n", headOnly: headOnly))
                return
            }
            writeAll(client, bytesResponse(status: 200, reason: "OK", type: Self.mime(for: url), cache: Self.cacheControl(for: url), body: body, headOnly: headOnly))
        }
    }

    private func readHeader(_ fd: Int32) -> Data? {
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 8192)
        while data.count <= 16 * 1024 {
            let count: Int = buffer.withUnsafeMutableBytes { raw in
                guard let base = raw.baseAddress else { return -1 }
                return Darwin.read(fd, base, raw.count)
            }
            if count == 0 { break }
            if count < 0 {
                if errno == EINTR { continue }
                return nil
            }
            data.append(contentsOf: buffer[0..<count])
            if data.range(of: marker) != nil { return data }
        }
        return data.range(of: marker) != nil ? data : nil
    }

    private func writeAll(_ fd: Int32, _ data: Data) {
        data.withUnsafeBytes { raw in
            guard let base = raw.baseAddress else { return }
            var sent = 0
            while sent < raw.count {
                let wrote = Darwin.write(fd, base.advanced(by: sent), raw.count - sent)
                if wrote < 0 {
                    if errno == EINTR { continue }
                    return
                }
                if wrote == 0 { return }
                sent += wrote
            }
        }
    }

    private enum Resolved {
        case file(URL)
        case badRequest
        case notFound
    }

    private func resolve(_ target: String) -> Resolved {
        let beforeQuery = target.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false).first.map(String.init) ?? ""
        let pathOnly = beforeQuery.split(separator: "#", maxSplits: 1, omittingEmptySubsequences: false).first.map(String.init) ?? ""
        guard pathOnly.hasPrefix("/") else { return .badRequest }
        guard let decoded = pathOnly.removingPercentEncoding else { return .badRequest }
        guard !decoded.contains("\0"), !decoded.contains("\\") else { return .badRequest }

        var url = root
        let relative = decoded == "/" ? "" : String(decoded.dropFirst())
        if !relative.isEmpty {
            for part in relative.split(separator: "/") {
                if part == "." || part.isEmpty { continue }
                if part == ".." { return .badRequest }
                url.appendPathComponent(String(part))
            }
        }
        let candidate = url.standardizedFileURL
        guard isInsideRoot(candidate) else { return .badRequest }

        var isDirectory: ObjCBool = false
        if FileManager.default.fileExists(atPath: candidate.path, isDirectory: &isDirectory) {
            if isDirectory.boolValue {
                let index = candidate.appendingPathComponent("index.html")
                if FileManager.default.fileExists(atPath: index.path) { return .file(index) }
                return .notFound
            }
            return .file(candidate)
        }
        if candidate.pathExtension.isEmpty {
            let index = root.appendingPathComponent("index.html")
            if FileManager.default.fileExists(atPath: index.path) { return .file(index) }
        }
        return .notFound
    }

    private func isInsideRoot(_ url: URL) -> Bool {
        let path = url.path
        let rootPath = root.path
        if path == rootPath { return true }
        let prefix = rootPath.hasSuffix("/") ? rootPath : rootPath + "/"
        return path.hasPrefix(prefix)
    }

    private static func mime(for url: URL) -> String {
        switch url.pathExtension.lowercased() {
        case "html", "htm": return "text/html; charset=utf-8"
        case "js", "mjs": return "text/javascript; charset=utf-8"
        case "css": return "text/css; charset=utf-8"
        case "json", "map": return "application/json"
        case "webmanifest": return "application/manifest+json"
        case "svg": return "image/svg+xml"
        case "png": return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "gif": return "image/gif"
        case "webp": return "image/webp"
        case "ico": return "image/x-icon"
        case "txt": return "text/plain; charset=utf-8"
        case "woff": return "font/woff"
        case "woff2": return "font/woff2"
        default: return "application/octet-stream"
        }
    }

    private static func cacheControl(for url: URL) -> String {
        let ext = url.pathExtension.lowercased()
        if ext == "html" || ext == "htm" { return "no-store" }
        return "no-cache"
    }

    private func textResponse(_ status: Int, _ reason: String, _ message: String, headOnly: Bool, extra: String = "") -> Data {
        bytesResponse(status: status, reason: reason, type: "text/plain; charset=utf-8", cache: "no-store", body: Data(message.utf8), headOnly: headOnly, extra: extra)
    }

    private func bytesResponse(status: Int, reason: String, type: String, cache: String, body: Data, headOnly: Bool, extra: String = "") -> Data {
        var head = "HTTP/1.1 \(status) \(reason)\r\n"
        head += "Content-Type: \(type)\r\n"
        head += "Content-Length: \(body.count)\r\n"
        head += "Cache-Control: \(cache)\r\n"
        head += "Connection: close\r\n"
        head += "X-Content-Type-Options: nosniff\r\n"
        head += extra
        head += "\r\n"
        var data = Data(head.utf8)
        if !headOnly { data.append(body) }
        return data
    }
}

enum StaticServerError: Error, CustomStringConvertible {
    case addressInUse
    case failed(String)

    var description: String {
        switch self {
        case .addressInUse: return "porta 5173 occupata"
        case .failed(let message): return message
        }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate {
    static let shared = AppDelegate()

    private var server: StaticServer?
    private var window: NSWindow?
    private var webView: WKWebView?
    private let paper = NSColor(srgbRed: 243.0 / 255.0, green: 236.0 / 255.0, blue: 223.0 / 255.0, alpha: 1)

    func installMenu() {
        let main = NSMenu()

        let appItem = NSMenuItem()
        main.addItem(appItem)
        let appMenu = NSMenu()
        appItem.submenu = appMenu
        appMenu.addItem(withTitle: "Informazioni su Scaffale", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Esci da Scaffale", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")

        let editItem = NSMenuItem()
        main.addItem(editItem)
        let edit = NSMenu(title: "Modifica")
        editItem.submenu = edit
        edit.addItem(withTitle: "Taglia", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copia", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Incolla", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Seleziona tutto", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")

        NSApp.mainMenu = main
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        guard let dist = bundledDist() else {
            stop(
                title: "Scaffale non è completo",
                message: "Manca index.html in Contents/Resources/dist. Ricostruisci con macos/build-app.sh."
            )
            return
        }
        let server = StaticServer(root: dist)
        do {
            try server.start()
        } catch StaticServerError.addressInUse {
            stop(
                title: "Porta 5173 occupata",
                message: "Scaffale deve aprirsi su http://127.0.0.1:5173/ perché è l’URI di reindirizzamento registrato su Spotify. La porta è già in uso, di solito da «npm run dev» o da un’altra copia dell’app. Chiudi quell’altro programma e riapri Scaffale."
            )
            return
        } catch {
            stop(
                title: "Scaffale non parte",
                message: "Non riesco ad aprire il server su http://127.0.0.1:5173/. \(error)"
            )
            return
        }
        self.server = server
        showWindow()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else {
            decisionHandler(.cancel)
            return
        }
        if navigationAction.targetFrame?.isMainFrame == false {
            decisionHandler(.allow)
            return
        }
        if Self.staysInWebView(url) {
            decisionHandler(.allow)
            return
        }
        if navigationAction.targetFrame != nil, Self.isBrowserURL(url) {
            NSWorkspace.shared.open(url)
        }
        decisionHandler(.cancel)
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        guard let url = navigationAction.request.url else { return nil }
        if Self.staysInWebView(url) {
            if url.scheme?.lowercased() != "about" {
                webView.load(URLRequest(url: url))
            }
            return nil
        }
        if Self.isBrowserURL(url) {
            NSWorkspace.shared.open(url)
        }
        return nil
    }

    private func showWindow() {
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1040, height: 760),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "Scaffale"
        window.minSize = NSSize(width: 720, height: 560)
        window.backgroundColor = paper
        window.setFrameAutosaveName("Scaffale")
        window.center()

        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = WKWebsiteDataStore.default()
        let preferences = WKWebpagePreferences()
        preferences.allowsContentJavaScript = true
        configuration.defaultWebpagePreferences = preferences

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = true
        webView.underPageBackgroundColor = paper
        if #available(macOS 13.3, *) {
            webView.isInspectable = true
        }
        webView.translatesAutoresizingMaskIntoConstraints = false
        window.contentView?.addSubview(webView)
        if let content = window.contentView {
            NSLayoutConstraint.activate([
                webView.leadingAnchor.constraint(equalTo: content.leadingAnchor),
                webView.trailingAnchor.constraint(equalTo: content.trailingAnchor),
                webView.topAnchor.constraint(equalTo: content.topAnchor),
                webView.bottomAnchor.constraint(equalTo: content.bottomAnchor),
            ])
        }

        self.window = window
        self.webView = webView
        window.makeKeyAndOrderFront(nil)
        activate()
        webView.load(URLRequest(url: URL(string: "http://127.0.0.1:5173/")!))
    }

    private func bundledDist() -> URL? {
        let fileManager = FileManager.default
        let candidates = [
            Bundle.main.resourceURL?.appendingPathComponent("dist", isDirectory: true),
            Bundle.main.bundleURL.appendingPathComponent("Contents/Resources/dist", isDirectory: true),
        ]
        for case let url? in candidates {
            if fileManager.fileExists(atPath: url.appendingPathComponent("index.html").path) {
                return url
            }
        }
        return nil
    }

    private func stop(title: String, message: String) {
        activate()
        let alert = NSAlert()
        alert.alertStyle = .critical
        alert.messageText = title
        alert.informativeText = message
        alert.addButton(withTitle: "Esci")
        alert.runModal()
        NSApp.terminate(nil)
    }

    private func activate() {
        if #available(macOS 14.0, *) {
            NSApp.activate()
        } else {
            NSApp.activate(ignoringOtherApps: true)
        }
    }

    private static func staysInWebView(_ url: URL) -> Bool {
        let scheme = url.scheme?.lowercased() ?? ""
        if scheme == "about" { return true }
        guard let host = url.host?.lowercased() else { return false }
        if host == "accounts.spotify.com", scheme == "https" { return true }
        if scheme == "http", host == "127.0.0.1" { return url.port == 5173 }
        return false
    }

    private static func isBrowserURL(_ url: URL) -> Bool {
        guard let scheme = url.scheme?.lowercased() else { return false }
        return scheme == "http" || scheme == "https" || scheme == "mailto"
    }
}

@main
enum ScaffaleMain {
    static func main() {
        let app = NSApplication.shared
        let delegate = AppDelegate.shared
        app.setActivationPolicy(.regular)
        app.delegate = delegate
        delegate.installMenu()
        app.run()
    }
}
