import Foundation
import WidgetKit

public final class SujiSystemNative: NSObject {
    private static let work = DispatchQueue(label: "suji.system.group")
    private struct Projection: Decodable { let owner: String; let rows: [WidgetSchedule] }

    private static func uuid(_ value: Any?) throws -> String {
        guard let text = value as? String, UUID(uuidString: text) != nil else {
            throw SujiGroupError("共享记录标识无效。")
        }
        return text
    }

    private static func refreshWidget() {
        if #available(iOS 14.0, *) { WidgetCenter.shared.reloadTimelines(ofKind: "SujiToday") }
    }

    public static func invoke(_ operation: String, _ payload: String, _ callback: @escaping (String) -> Void) {
        work.async {
            let reply: [String: Any]
            do {
                let input = Data(payload.utf8)
                guard let args = try JSONSerialization.jsonObject(with: input) as? [String: Any] else {
                    throw SujiGroupError("系统入口参数无效。")
                }
                let store = try SujiGroupStore()
                var data: Any = NSNull()
                switch operation {
                case "setOwner":
                    let owner = args["owner"] is NSNull ? nil : try uuid(args["owner"])
                    if try store.setOwner(owner) { refreshWidget() }
                case "shares": data = try store.shares()
                case "ackShare": try store.ackShare(try uuid(args["id"]))
                case "navigation": data = try store.navigation() as Any? ?? NSNull()
                case "ackNavigation": try store.ackNavigation(try uuid(args["id"]))
                case "widget":
                    let projection = try JSONDecoder().decode(Projection.self, from: input)
                    if try store.setWidget(try uuid(projection.owner), projection.rows) { refreshWidget() }
                default: throw SujiGroupError("无法识别的系统入口操作。")
                }
                reply = ["ok": true, "data": data]
            } catch { reply = ["ok": false, "error": error.localizedDescription] }
            let bytes = try? JSONSerialization.data(withJSONObject: reply)
            let json = bytes.flatMap { String(data: $0, encoding: .utf8) } ?? #"{"ok":false,"error":"系统入口响应编码失败。"}"#
            DispatchQueue.main.async { callback(json) }
        }
    }

    public static func openURL(_ raw: String) -> Bool {
        guard let url = URLComponents(string: raw), url.scheme == "aisuji", url.host == "widget",
              url.user == nil, url.password == nil, url.port == nil, url.fragment == nil else { return false }
        do {
            let store = try SujiGroupStore()
            if url.path == "/record", url.query == nil {
                try store.enqueueNavigation(kind: "record", owner: nil, schedule: nil, at: nil)
            } else if url.path == "/schedule" {
                let items = url.queryItems ?? []
                guard items.count == 3,
                      let id = items.first(where: { $0.name == "id" })?.value, UUID(uuidString: id) != nil,
                      let owner = items.first(where: { $0.name == "owner" })?.value, UUID(uuidString: owner) != nil,
                      let stamp = items.first(where: { $0.name == "at" })?.value, let at = Int64(stamp),
                      (0...253402300799999).contains(at) else { return false }
                try store.enqueueNavigation(kind: "schedule", owner: owner, schedule: id, at: at)
            } else { return false }
            return true
        } catch {
            NSLog("AI速记无法保存小组件导航：%@", error.localizedDescription)
            return false
        }
    }
}
