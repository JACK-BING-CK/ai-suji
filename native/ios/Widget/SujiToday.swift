import SwiftUI
import WidgetKit

private struct DayEntry: TimelineEntry {
    let date: Date
    let owner: String?
    let rows: [SujiWidgetRow]
    let message: String
}

private struct TodayProvider: TimelineProvider {
    func placeholder(in context: Context) -> DayEntry {
        DayEntry(date: Date(), owner: nil, rows: [], message: "今天没有待办")
    }

    private func entry(_ date: Date, store: SujiGroupStore, sql: String) throws -> DayEntry {
        let (owner, rows) = try store.widgetRows(at: date, query: sql)
        return DayEntry(date: date, owner: owner, rows: rows, message: "今天没有待办")
    }

    private func timeline(_ now: Date) -> [DayEntry] {
        do {
            let store = try SujiGroupStore()
            guard let url = Bundle.main.url(forResource: "suji_widget_today", withExtension: "sql") else {
                throw SujiGroupError("组件缺少查询文件")
            }
            let sql = try String(contentsOf: url, encoding: .utf8)
            let calendar = Calendar.autoupdatingCurrent
            let start = calendar.startOfDay(for: now)
            let dates = [now] + (1...6).compactMap { calendar.date(byAdding: .day, value: $0, to: start) }
            return try dates.map { try entry($0, store: store, sql: sql) }
        } catch {
            return [DayEntry(date: now, owner: nil, rows: [], message: "解锁并打开 AI速记刷新待办")]
        }
    }

    func getSnapshot(in context: Context, completion: @escaping (DayEntry) -> Void) {
        if context.isPreview { completion(placeholder(in: context)); return }
        completion(timeline(Date())[0])
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<DayEntry>) -> Void) {
        let entries = timeline(Date())
        let last = entries[entries.count - 1].date
        let refresh = entries.count == 1 ? last.addingTimeInterval(15 * 60) : last
        completion(Timeline(entries: entries, policy: .after(refresh)))
    }
}

private struct TodayView: View {
    let entry: DayEntry
    private let record = URL(string: "aisuji://widget/record")!

    private func detail(_ row: SujiWidgetRow, owner: String) -> URL {
        var url = URLComponents()
        url.scheme = "aisuji"
        url.host = "widget"
        url.path = "/schedule"
        url.queryItems = [URLQueryItem(name: "id", value: row.id), URLQueryItem(name: "at", value: String(row.at)),
                          URLQueryItem(name: "owner", value: owner)]
        return url.url ?? record
    }

    private var contents: some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack {
                Text("今日待办").font(.headline)
                Spacer()
                Link(destination: record) { Label("记一笔", systemImage: "square.and.pencil").font(.subheadline) }
            }
            if entry.rows.isEmpty {
                Text(entry.message).font(.subheadline).foregroundColor(.secondary)
                Spacer(minLength: 0)
            } else if let owner = entry.owner {
                ForEach(entry.rows, id: \.occurrenceKey) { row in
                    Link(destination: detail(row, owner: owner)) {
                        HStack {
                            Text(row.title).lineLimit(1)
                            Spacer(minLength: 4)
                            Text(Date(timeIntervalSince1970: Double(row.at) / 1000), style: .time)
                                .font(.caption).foregroundColor(.secondary)
                        }.frame(maxWidth: .infinity, alignment: .leading)
                    }.accessibilityHint("打开此日程")
                }
            }
        }.widgetURL(record)
    }

    @ViewBuilder var body: some View {
        if #available(iOS 17.0, *) {
            contents.privacySensitive().containerBackground(for: .widget) { Color(.systemBackground) }
        } else if #available(iOS 15.0, *) {
            contents.padding().privacySensitive()
        } else {
            contents.padding()
        }
    }
}

@main
struct SujiToday: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "SujiToday", provider: TodayProvider()) { TodayView(entry: $0) }
            .configurationDisplayName("AI速记 · 今日待办")
            .description("查看前三条待办，或点「记一笔」打开速记。")
            .supportedFamilies([.systemMedium, .systemLarge])
    }
}
