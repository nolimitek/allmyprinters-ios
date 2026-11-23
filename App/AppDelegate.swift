import UIKit

/// AllMyPrinters für iOS: ein Fenster, eine WKWebView mit derselben Oberfläche wie die Android-App (www/).
/// Alles Druckerwissen steckt in der Oberfläche (backend.js); hier nur, was der Browser nicht darf — siehe Bridge.swift.
@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        let w = UIWindow(frame: UIScreen.main.bounds)
        w.rootViewController = WebViewController()
        w.makeKeyAndVisible()
        window = w
        Log.write("start \(Bundle.main.infoDictionary?["CFBundleShortVersionString"] ?? "?") iOS \(UIDevice.current.systemVersion)")
        return true
    }
}
