import Foundation
import SQLite3

struct SujiGroupError: LocalizedError {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}

struct WidgetSchedule: Decodable {
    let id: String
    let title: String
    let start_at: Int64
    let end_at: Int64
    let repeat_rule: String?
    let priority: Int
    let done: Int
    let completed_slots: [String]
}

struct SujiWidgetRow {
    let id: String
    let title: String
    let at: Int64
    var occurrenceKey: String { "\(id):\(at)" }
}

private enum SQLValue {
    case string(String), number(Int64), null
    static func optional(_ value: String?) -> SQLValue { value.map { .string($0) } ?? .null }
}

final class SujiGroupStore {
    private let db: OpaquePointer
    private let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

    convenience init() throws {
        guard let group = Bundle.main.object(forInfoDictionaryKey: "SujiAppGroup") as? String,
              let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group)
        else { throw SujiGroupError("无法访问共享存储，请检查 App Group 签名。") }
        let directory = container.appendingPathComponent("SujiSystem", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
            attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
        try self.init(file: directory.appendingPathComponent("system.sqlite"))
    }

    init(file: URL) throws {
        var handle: OpaquePointer?
        guard sqlite3_open_v2(file.path, &handle, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX, nil) == SQLITE_OK,
              let opened = handle else {
            if let handle = handle { sqlite3_close(handle) }
            throw SujiGroupError("无法打开 AI速记共享数据库。")
        }
        db = opened
        sqlite3_busy_timeout(db, 3000)
        try run("CREATE TABLE IF NOT EXISTS account (singleton INTEGER PRIMARY KEY CHECK(singleton=1), owner TEXT)")
        try run("CREATE TABLE IF NOT EXISTS share_queue (seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, owner TEXT, text TEXT NOT NULL)")
        try run("CREATE TABLE IF NOT EXISTS navigation_queue (seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, owner TEXT, schedule_id TEXT, at INTEGER)")
        try run("CREATE TABLE IF NOT EXISTS widget_schedule (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, title TEXT, start_at INTEGER, end_at INTEGER, repeat_rule TEXT, priority INTEGER, done INTEGER, completed_slots TEXT)")
    }

    deinit { sqlite3_close(db) }

    private func prepared<T>(_ sql: String, _ body: (OpaquePointer) throws -> T) throws -> T {
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK, let statement = statement
        else { throw SujiGroupError("无法读取共享数据结构。") }
        defer { sqlite3_finalize(statement) }
        return try body(statement)
    }

    private func bind(_ values: [SQLValue], _ statement: OpaquePointer) throws {
        for (i, value) in values.enumerated() {
            let index = Int32(i + 1)
            let result: Int32
            switch value {
            case .string(let text):
                result = text.withCString { sqlite3_bind_text(statement, index, $0, Int32(text.utf8.count), transient) }
            case .number(let number): result = sqlite3_bind_int64(statement, index, number)
            case .null: result = sqlite3_bind_null(statement, index)
            }
            guard result == SQLITE_OK else { throw SujiGroupError("无法绑定共享数据。") }
        }
    }

    private func execute(_ statement: OpaquePointer, _ values: [SQLValue]) throws {
        sqlite3_reset(statement)
        try bind(values, statement)
        guard sqlite3_step(statement) == SQLITE_DONE else { throw SujiGroupError("共享存储写入失败，请重试。") }
    }

    private func run(_ sql: String, _ values: [SQLValue] = []) throws {
        try prepared(sql) { try execute($0, values) }
    }

    private func read<T>(_ sql: String, _ values: [SQLValue] = [], _ map: (OpaquePointer) -> T) throws -> [T] {
        try prepared(sql) { statement in
            try bind(values, statement)
            var rows: [T] = []
            while true {
                switch sqlite3_step(statement) {
                case SQLITE_ROW: rows.append(map(statement))
                case SQLITE_DONE: return rows
                default: throw SujiGroupError("共享存储读取失败，请重试。")
                }
            }
        }
    }

    private func string(_ stmt: OpaquePointer, _ col: Int32) -> String? {
        guard let ptr = sqlite3_column_text(stmt, col) else { return nil }
        return String(decoding: UnsafeBufferPointer(start: ptr, count: Int(sqlite3_column_bytes(stmt, col))), as: UTF8.self)
    }

    private func transaction<T>(_ write: Bool = true, _ body: () throws -> T) throws -> T {
        try run(write ? "BEGIN IMMEDIATE" : "BEGIN")
        do {
            let result = try body()
            try run("COMMIT")
            return result
        } catch {
            if sqlite3_get_autocommit(db) == 0 { try run("ROLLBACK") }
            throw error
        }
    }

    func currentOwner() throws -> String? {
        try read("SELECT owner FROM account WHERE singleton=1") { string($0, 0) ?? "" }.first.flatMap { $0.isEmpty ? nil : $0 }
    }

    func setOwner(_ owner: String?) throws -> Bool {
        try transaction {
            let previous = try currentOwner()
            let changed = previous != owner
            if changed {
                if let previous = previous {
                    try run("DELETE FROM widget_schedule WHERE user_id=?", [.string(previous)])
                    try run("DELETE FROM navigation_queue WHERE owner=?", [.string(previous)])
                }
                try run("INSERT OR REPLACE INTO account(singleton,owner) VALUES (1,?)", [.optional(owner)])
            }
            if let owner = owner {
                // 首次建立本机身份时认领匿名分享，之后切换帐号仍保留其原归属。
                try run("UPDATE share_queue SET owner=? WHERE owner IS NULL", [.string(owner)])
            }
            return changed
        }
    }

    func enqueueShare(_ text: String, owner: String?) throws {
        try transaction {
            guard try currentOwner() == owner else { throw SujiGroupError("当前账号已切换，请重新分享。") }
            try run("INSERT INTO share_queue(id,owner,text) VALUES (?,?,?)",
                    [.string(UUID().uuidString.lowercased()), .optional(owner), .string(text)])
        }
    }

    func shares() throws -> [[String: Any]] {
        try read("SELECT id,owner,text FROM share_queue WHERE owner IS (SELECT owner FROM account WHERE singleton=1) ORDER BY seq") { s in
            ["id": string(s, 0)!, "owner": string(s, 1) as Any? ?? NSNull(), "text": string(s, 2)!]
        }
    }

    func ackShare(_ id: String) throws {
        try run("DELETE FROM share_queue WHERE id=? AND owner IS (SELECT owner FROM account WHERE singleton=1)", [.string(id)])
    }

    func setWidget(_ owner: String, _ rows: [WidgetSchedule]) throws -> Bool {
        try transaction {
            guard try currentOwner() == owner else { return false }
            try run("DELETE FROM widget_schedule WHERE user_id=?", [.string(owner)])
            try prepared("INSERT INTO widget_schedule(id,user_id,title,start_at,end_at,repeat_rule,priority,done,completed_slots) VALUES (?,?,?,?,?,?,?,?,?)") { statement in
                for row in rows {
                    let slots = row.completed_slots.isEmpty ? "," : "," + row.completed_slots.joined(separator: ",") + ","
                    try execute(statement, [.string(row.id), .string(owner), .string(row.title), .number(row.start_at), .number(row.end_at),
                        .optional(row.repeat_rule), .number(Int64(row.priority)), .number(Int64(row.done)), .string(slots)])
                }
            }
            return true
        }
    }

    func widgetRows(at: Date, query: String) throws -> (String?, [SujiWidgetRow]) {
        try transaction(false) {
            guard let owner = try currentOwner() else { return (nil, []) }
            let rows = try read(query, [.number(Int64(at.timeIntervalSince1970 * 1000)), .string(owner)]) { s in
                SujiWidgetRow(id: string(s, 0)!, title: string(s, 1)!, at: sqlite3_column_int64(s, 2))
            }
            return (owner, Array(rows.prefix(3)))
        }
    }

    func enqueueNavigation(kind: String, owner: String?, schedule: String?, at: Int64?) throws {
        try transaction {
            if kind == "schedule", try currentOwner() != owner { return }
            try run("INSERT INTO navigation_queue(id,kind,owner,schedule_id,at) VALUES(?,?,?,?,?)",
                    [.string(UUID().uuidString.lowercased()), .string(kind), .optional(owner), .optional(schedule),
                     at.map { .number($0) } ?? .null])
        }
    }

    func navigation() throws -> [String: Any]? {
        try read("SELECT id,kind,owner,schedule_id,at FROM navigation_queue WHERE (owner IS NULL AND kind='record') OR owner=(SELECT owner FROM account WHERE singleton=1) ORDER BY seq LIMIT 1") { s in
            var row: [String: Any] = ["id": string(s, 0)!, "kind": string(s, 1)!, "owner": string(s, 2) as Any? ?? NSNull()]
            if let schedule = string(s, 3) {
                row["scheduleId"] = schedule
                row["at"] = sqlite3_column_int64(s, 4)
            }
            return row
        }.first
    }

    func ackNavigation(_ id: String) throws {
        try run("DELETE FROM navigation_queue WHERE id=? AND ((owner IS NULL AND kind='record') OR owner=(SELECT owner FROM account WHERE singleton=1))", [.string(id)])
    }
}
