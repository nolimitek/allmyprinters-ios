import UIKit

/// AllMyPrinters für iOS: ein Fenster, eine WKWebView mit derselben Oberfläche wie die Android-App (www/).
/// Alles Druckerwissen steckt in der Oberfläche (backend.js); hier nur, was der Browser nicht darf — siehe Bridge.swift.
@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        let w = UIWindow(frame: UIScreen.main.bounds)
        let vc = WebViewController()
        Push.shared.vc = vc
        Push.shared.launched()   // Meldungs-Empfänger setzen, bevor iOS ein angetipptes Push beim Kaltstart zustellt
        News.register()   // Neuigkeiten im Hintergrund (App/News.swift) — muss vor dem Ende des Starts angemeldet sein
        News.schedule()
        w.rootViewController = vc
        w.makeKeyAndVisible()
        window = w
        Log.write("start \(Bundle.main.infoDictionary?["CFBundleShortVersionString"] ?? "?") iOS \(UIDevice.current.systemVersion)")
        return true
    }

    func applicationDidEnterBackground(_ application: UIApplication) { News.schedule() }

    // Apple-Push (Druck-Meldungen über den Agenten, App/Push.swift)
    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) { Push.shared.didRegister(deviceToken) }
    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) { Push.shared.didFail(error) }
}
