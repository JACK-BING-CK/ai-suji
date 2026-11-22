import Foundation
import UIKit
import UserNotifications

private struct Reminder: Codable {
    let id: String
    let owner: String
    let scheduleId: String
    var at: Int64
    let level: Int
    let title: String
    let body: String
    let snoozeMin: Int
    let sound: String?
}

private struct ReminderAction: Codable {
    let key: String
    let id: String
    let owner: String
    let scheduleId: String
    let type: String
    let at: Int64
    let scheduledAt: Int64
}

private struct ReminderState: Codable {
    var registered: [String: Reminder] = [:]
    var actions: [ReminderAction] = []

    private static func location() throws -> URL {
        let folder = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask,
                                                 appropriateFor: nil, create: true)
        return folder.appendingPathComponent("suji-local-notifications.json")
    }

    static func read() throws -> ReminderState {
        let file = try location()
        guard FileManager.default.fileExists(atPath: file.path) else { return ReminderState() }
        return try JSONDecoder().decode(ReminderState.self, from: Data(contentsOf: file))
    }

    func save() throws {
        // 先原子写入操作，再告诉系统回调已处理；锁屏后仍可读取已解锁过的手机的数据。
        try JSONEncoder().encode(self).write(to: Self.location(),
            options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }
}

private struct ReminderFailure: LocalizedError {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}

public final class SujiLocalNotifications: NSObject, UNUserNotificationCenterDelegate {
    private static let shared = SujiLocalNotifications()
    private let center = UNUserNotificationCenter.current()
    private let prefix = "suji.reminder."
    private let categoryPrefix = "suji.alarm."
    private let soundName = "suji-chime.wav"
    private weak var previousDelegate: UNUserNotificationCenterDelegate?
    private typealias Finish = () -> Void
    private typealias Work = (@escaping Finish) -> Void
    private typealias Reply = (Result<Any, Error>) -> Void
    private var work: [Work] = []

    public static func install() {
        let native = shared
        if native.center.delegate !== native {
            native.previousDelegate = native.center.delegate
            native.center.delegate = native
        }
    }

    // 所有对通知中心与动作文件的修改顺序执行，取消不会被较早的异步注册覆盖。
    private func enqueue(_ block: @escaping Work) {
        DispatchQueue.main.async {
            self.work.append(block)
            if self.work.count == 1 { self.runFirst() }
        }
    }

    private func runFirst() {
        work.first? {
            DispatchQueue.main.async {
                self.work.removeFirst()
                self.runFirst()
            }
        }
    }

    public static func invoke(_ operation: String, _ payload: String, _ callback: @escaping (String) -> Void) {
        shared.enqueue { finish in
            install()
            shared.execute(operation, payload) { result in
                let response: [String: Any]
                switch result {
                case .success(let data): response = ["ok": true, "data": data]
                case .failure(let error): response = ["ok": false, "error": error.localizedDescription]
                }
                do {
                    let bytes = try JSONSerialization.data(withJSONObject: response)
                    let json = String(decoding: bytes, as: UTF8.self)
                    DispatchQueue.main.async { callback(json) }
                } catch {
                    DispatchQueue.main.async { callback("{\"ok\":false,\"error\":\"系统提醒结果无法读取。\"}") }
                }
                finish()
            }
        }
    }

    private func object<T: Encodable>(_ value: T) throws -> Any {
        return try JSONSerialization.jsonObject(with: JSONEncoder().encode(value))
    }

    private func now() -> Int64 { Int64(Date().timeIntervalSince1970 * 1000) }

    private func allowed(_ settings: UNNotificationSettings) -> Bool {
        if #available(iOS 14.0, *), settings.authorizationStatus == .ephemeral { return true }
        return [.authorized, .provisional].contains(settings.authorizationStatus)
    }

    private func execute(_ operation: String, _ payload: String, _ reply: @escaping Reply) {
        do {
            let bytes = Data(payload.utf8)
            let fields = try JSONSerialization.jsonObject(with: bytes) as? [String: Any] ?? [:]
            switch operation {
            case "schedule":
                let item = try JSONDecoder().decode(Reminder.self, from: bytes)
                guard [item.id, item.owner, item.scheduleId].allSatisfy({ UUID(uuidString: $0) != nil }),
                      [0, 1].contains(item.level), item.snoozeMin > 0, item.snoozeMin <= Int(Int32.max),
                      !item.title.isEmpty else { throw ReminderFailure("提醒数据无效。") }
                var state = try ReminderState.read()
                add(item) { error in
                    if let error = error { reply(.failure(error)); return }
                    do {
                        state.registered[item.id] = item
                        try state.save()
                        reply(.success(NSNull()))
                    } catch {
                        self.removeNotification(item.id)
                        reply(.failure(error))
                    }
                }
            case "cancel":
                guard let id = fields["id"] as? String, UUID(uuidString: id) != nil else {
                    throw ReminderFailure("缺少提醒编号。")
                }
                var state = try ReminderState.read()
                state.registered.removeValue(forKey: id)
                try state.save()
                removeNotification(id)
                reply(.success(NSNull()))
            case "list":
                list(reply)
            case "actions":
                reply(.success(try object(ReminderState.read().actions)))
            case "ack":
                guard let key = fields["key"] as? String else { throw ReminderFailure("缺少提醒操作编号。") }
                var state = try ReminderState.read()
                state.actions.removeAll { $0.key == key }
                try state.save()
                reply(.success(NSNull()))
            case "permissions":
                center.getNotificationSettings { settings in
                    let result: [String: Any] = ["notifications": self.allowed(settings),
                        "exact": NSNull(), "battery": NSNull(), "fullscreen": NSNull()]
                    reply(.success(result))
                }
            case "settings":
                guard fields["kind"] as? String == "notifications" else {
                    throw ReminderFailure("此权限仅适用于 Android。")
                }
                openSettings(reply)
            default:
                throw ReminderFailure("不支持此提醒操作。")
            }
        } catch { reply(.failure(error)) }
    }

    private func removeNotification(_ id: String) {
        let identifiers = [prefix + id]
        center.removePendingNotificationRequests(withIdentifiers: identifiers)
        center.removeDeliveredNotifications(withIdentifiers: identifiers)
    }

    private func original(_ request: UNNotificationRequest) -> Reminder? {
        guard request.identifier.hasPrefix(prefix),
              let text = request.content.userInfo["suji"] as? String,
              let row = try? JSONDecoder().decode(Reminder.self, from: Data(text.utf8)),
              request.identifier == prefix + row.id else { return nil }
        return row
    }

    private func list(_ reply: @escaping Reply) {
        center.getPendingNotificationRequests { pending in
            self.center.getDeliveredNotifications { delivered in
                do {
                    var result: [String: [String: Any]] = [:]
                    for (requests, phase) in [(delivered.map { $0.request }, "shown"), (pending, "pending")] {
                        for request in requests {
                            guard let item = self.original(request), var row = try self.object(item) as? [String: Any] else { continue }
                            if item.sound == nil { row["sound"] = NSNull() }
                            row["phase"] = phase
                            result[item.id] = row
                        }
                    }
                    reply(.success(Array(result.values)))
                } catch { reply(.failure(error)) }
            }
        }
    }

    private func openSettings(_ reply: @escaping Reply) {
        center.getNotificationSettings { settings in
            if settings.authorizationStatus == .notDetermined {
                self.center.requestAuthorization(options: [.alert, .sound]) { granted, error in
                    if let error = error { reply(.failure(error)) }
                    else { reply(.success(granted)) }
                }
                return
            }
            DispatchQueue.main.async {
                let path: String
                if #available(iOS 16.0, *) { path = UIApplication.openNotificationSettingsURLString }
                else { path = UIApplication.openSettingsURLString }
                guard let url = URL(string: path) else { reply(.failure(ReminderFailure("系统设置地址无效。"))); return }
                UIApplication.shared.open(url, options: [:]) { opened in
                    if opened { reply(.success(true)) }
                    else { reply(.failure(ReminderFailure("请在系统设置中打开 AI速记 的通知权限。"))) }
                }
            }
        }
    }

    private func registerCategory(_ item: Reminder, _ proceed: @escaping () -> Void) {
        guard item.level == 1 else { proceed(); return }
        let identifier = categoryPrefix + String(item.snoozeMin)
        center.getNotificationCategories { existing in
            if !existing.contains(where: { $0.identifier == identifier }) {
                let done = UNNotificationAction(identifier: "suji.done", title: "完成", options: [.foreground])
                let later = UNNotificationAction(identifier: "suji.snooze", title: "\(item.snoozeMin) 分钟后再提醒", options: [.foreground])
                let category = UNNotificationCategory(identifier: identifier, actions: [done, later],
                    intentIdentifiers: [], options: [])
                self.center.setNotificationCategories(existing.union([category]))
            }
            proceed()
        }
    }

    private func request(_ item: Reminder) throws -> UNNotificationRequest {
        let content = UNMutableNotificationContent()
        content.title = item.title
        content.body = item.body
        content.userInfo = ["suji": String(decoding: try JSONEncoder().encode(item), as: UTF8.self)]
        if item.level == 1 {
            // iOS 的自定义通知铃声必须短于 30 秒，超时会改播系统默认音；内置铃声为 24 秒。
            guard Bundle.main.url(forResource: "suji-chime", withExtension: "wav") != nil else {
                throw ReminderFailure("安装包缺少闹钟铃声，请重新打包。")
            }
            content.sound = UNNotificationSound(named: UNNotificationSoundName(rawValue: soundName))
            content.categoryIdentifier = categoryPrefix + String(item.snoozeMin)
        } else { content.sound = .default }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        let fire = Date(timeIntervalSince1970: ceil(Double(item.at) / 1000))
        var parts = calendar.dateComponents([.year, .month, .day, .hour, .minute, .second], from: fire)
        parts.timeZone = calendar.timeZone
        parts.calendar = calendar
        return UNNotificationRequest(identifier: prefix + item.id, content: content,
                                     trigger: UNCalendarNotificationTrigger(dateMatching: parts, repeats: false))
    }

    private func add(_ item: Reminder, _ completion: @escaping (Error?) -> Void) {
        guard item.at > now() else { completion(ReminderFailure("提醒时间已过，请重新选择。")); return }
        center.getNotificationSettings { settings in
            guard self.allowed(settings) else { completion(ReminderFailure("请先开启通知权限。")); return }
            self.center.getPendingNotificationRequests { pending in
                guard pending.count < 64 || pending.contains(where: { $0.identifier == self.prefix + item.id }) else {
                    completion(ReminderFailure("iOS 待发通知已满，打开应用后会继续登记较晚的提醒。"))
                    return
                }
                self.registerCategory(item) {
                    do {
                        let notification = try self.request(item)
                        self.center.add(notification, withCompletionHandler: completion)
                    } catch { completion(error) }
                }
            }
        }
    }

    public func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                       withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        guard original(notification.request) != nil else {
            if let delegate = previousDelegate, delegate.responds(to: #selector(UNUserNotificationCenterDelegate.userNotificationCenter(_:willPresent:withCompletionHandler:))) {
                delegate.userNotificationCenter?(center, willPresent: notification, withCompletionHandler: completionHandler)
            } else { completionHandler([]) }
            return
        }
        if #available(iOS 14.0, *) { completionHandler([.banner, .list, .sound]) }
        else { completionHandler([.alert, .sound]) }
    }

    public func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                       withCompletionHandler completionHandler: @escaping () -> Void) {
        guard let item = original(response.notification.request) else {
            if let delegate = previousDelegate, delegate.responds(to: #selector(UNUserNotificationCenterDelegate.userNotificationCenter(_:didReceive:withCompletionHandler:))) {
                delegate.userNotificationCenter?(center, didReceive: response, withCompletionHandler: completionHandler)
            } else { completionHandler() }
            return
        }
        enqueue { finish in
            let end = { completionHandler(); finish() }
            do {
                var state = try ReminderState.read()
                guard let current = state.registered[item.id], current.at == item.at,
                      current.owner == item.owner, current.scheduleId == item.scheduleId else { end(); return }
                let type: String
                switch response.actionIdentifier {
                case UNNotificationDefaultActionIdentifier: type = "open"
                case "suji.done": type = "done"
                case "suji.snooze": type = "snooze"
                default: end(); return
                }
                let at = type == "snooze" ? self.now() + Int64(item.snoozeMin) * 60_000 : item.at
                state.actions.append(ReminderAction(key: UUID().uuidString, id: item.id, owner: item.owner,
                    scheduleId: item.scheduleId, type: type, at: at, scheduledAt: item.at))
                state.registered.removeValue(forKey: item.id)
                var next = item
                if type == "snooze" {
                    next.at = at
                    state.registered[item.id] = next
                }
                try state.save()
                self.center.removeDeliveredNotifications(withIdentifiers: [self.prefix + item.id])
                if type == "snooze" {
                    // 先保留操作，再立即重排。即使系统拒绝，前台仍会回写 SQLite 并提示重试。
                    self.add(next) { error in
                        if let error = error { self.reportActionError(error) }
                        end()
                    }
                } else { end() }
            } catch { self.reportActionError(error); end() }
        }
    }

    private func reportActionError(_ error: Error) {
        NSLog("AI速记本地提醒操作失败：%@", error.localizedDescription)
        DispatchQueue.main.async {
            guard let window = UIApplication.shared.windows.first(where: { $0.isKeyWindow }),
                  var presenter = window.rootViewController else { return }
            while let presented = presenter.presentedViewController { presenter = presented }
            let alert = UIAlertController(title: "提醒操作失败", message: "请打开日程核对提醒并重试。", preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "知道了", style: .default))
            presenter.present(alert, animated: true)
        }
    }

    public func userNotificationCenter(_ center: UNUserNotificationCenter, openSettingsFor notification: UNNotification?) {
        previousDelegate?.userNotificationCenter?(center, openSettingsFor: notification)
    }
}
