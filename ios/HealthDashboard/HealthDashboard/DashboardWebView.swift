import SwiftUI
import WebKit

struct DashboardWebView: UIViewRepresentable {
    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        let uc = WKUserContentController()
        uc.add(context.coordinator, name: "healthDashboardBridge")
        let boot = WKUserScript(
            source: "window.__HEALTH_DASH_IOS__ = true;",
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        )
        uc.addUserScript(boot)
        config.userContentController = uc
        let webView = WKWebView(frame: .zero, configuration: config)
        context.coordinator.webView = webView
        if let url = Bundle.main.url(forResource: "health_dashboard_replica", withExtension: "html") {
            webView.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
        }
        return webView
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}

    final class Coordinator: NSObject, WKScriptMessageHandler {
        weak var webView: WKWebView?
        private let aggregator = HealthKitDailyAggregator()

        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            guard message.name == "healthDashboardBridge" else { return }
            let action = (message.body as? String) ?? ""
            guard action == "load" || action == "refresh" else { return }
            Task {
                if action == "refresh" {
                    await MainActor.run {
                        webView?.evaluateJavaScript(
                            "document.getElementById('refreshStatus') && (document.getElementById('refreshStatus').textContent = 'Refreshing…')",
                            completionHandler: nil
                        )
                    }
                }
                do {
                    try await aggregator.requestAuthorizationIfNeeded()
                    let csv = try await aggregator.buildDailyCsv()
                    let b64 = Data(csv.utf8).base64EncodedString()
                    let js = "window.__applyDashboardCsvFromBase64('\(b64)')"
                    await MainActor.run {
                        guard let wv = webView else { return }
                        wv.evaluateJavaScript(js) { _, err in
                            if let err {
                                Task { @MainActor in
                                    let esc = String(describing: err).replacingOccurrences(of: "'", with: "\\'")
                                    wv.evaluateJavaScript(
                                        "document.getElementById('refreshStatus') && (document.getElementById('refreshStatus').textContent = 'Native: \(esc)')",
                                        completionHandler: nil
                                    )
                                }
                            } else if action == "refresh" {
                                let t = DateFormatter.localizedString(from: Date(), dateStyle: .none, timeStyle: .medium)
                                wv.evaluateJavaScript(
                                    "document.getElementById('refreshStatus') && (document.getElementById('refreshStatus').textContent = 'Updated at \(t)')",
                                    completionHandler: nil
                                )
                            }
                        }
                    }
                } catch {
                    let msg = error.localizedDescription.replacingOccurrences(of: "'", with: "\\'")
                    await MainActor.run {
                        webView?.evaluateJavaScript(
                            "document.getElementById('refreshStatus') && (document.getElementById('refreshStatus').textContent = 'Health: \(msg)')",
                            completionHandler: nil
                        )
                    }
                }
            }
        }
    }
}
