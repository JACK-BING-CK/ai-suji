import Foundation
import UIKit

@objc(ShareViewController)
final class ShareViewController: UIViewController {
    private let message = UILabel()
    private let close = UIButton(type: .system)
    private var started = false
    private let background = DispatchQueue(label: "suji.share.inbox")

    override func viewDidLoad() {
        super.viewDidLoad()
        if #available(iOS 13.0, *) { view.backgroundColor = .systemBackground }
        else { view.backgroundColor = .white }
        message.text = "正在保存到 AI速记…"
        message.numberOfLines = 0
        message.textAlignment = .center
        message.font = .preferredFont(forTextStyle: .body)
        message.adjustsFontForContentSizeCategory = true
        close.setTitle("返回", for: .normal)
        close.addTarget(self, action: #selector(finish), for: .touchUpInside)
        close.isHidden = true
        let stack = UIStackView(arrangedSubviews: [message, close])
        stack.axis = .vertical
        stack.spacing = 12
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            stack.leadingAnchor.constraint(equalTo: view.layoutMarginsGuide.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: view.layoutMarginsGuide.trailingAnchor)
        ])
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        guard !started else { return }
        started = true
        let items = extensionContext?.inputItems.compactMap { $0 as? NSExtensionItem } ?? []
        let content = items.compactMap { $0.attributedContentText?.string }
        let providers = items.flatMap { $0.attachments ?? [] }
        // 同一提供者可能同时给出标题文字及原始网址；只在合并结果时去重。
        let jobs: [(NSItemProvider, String)] = providers.flatMap { provider in
            ["public.plain-text", "public.url"].compactMap { type in
                provider.hasItemConformingToTypeIdentifier(type) ? (provider, type) : nil
            }
        }
        do {
            let owner = try SujiGroupStore().currentOwner()
            load(jobs[...], parts: content, owner: owner)
        } catch { failed(error) }
    }

    private func load(_ jobs: ArraySlice<(NSItemProvider, String)>, parts: [String], owner: String?) {
        guard let (provider, type) = jobs.first else {
            background.async {
                do {
                    var combined: [String] = []
                    for part in parts.map({ $0.trimmingCharacters(in: .whitespacesAndNewlines) }) where !part.isEmpty {
                        let link = ["http", "https"].contains(URL(string: part)?.scheme?.lowercased() ?? "")
                        if !combined.contains(where: { $0 == part || (link && $0.contains(part)) }) {
                            combined.append(part)
                        }
                    }
                    let text = combined.joined(separator: "\n")
                    guard !text.isEmpty else { throw SujiGroupError("没有可保存的文字或网址。") }
                    guard text.unicodeScalars.count <= 2000 else { throw SujiGroupError("分享超过 2000 字，请缩短后再试。") }
                    try SujiGroupStore().enqueueShare(text, owner: owner)
                    DispatchQueue.main.async { self.finish() }
                } catch { self.failed(error) }
            }
            return
        }
        provider.loadItem(forTypeIdentifier: type, options: nil) { item, error in
            var text: String?
            if let url = item as? URL { text = url.absoluteString }
            else if let value = item as? String { text = value }
            else if let value = item as? NSAttributedString { text = value.string }
            else if let bytes = item as? Data { text = String(data: bytes, encoding: .utf8) }
            if type == "public.url", let value = text, let scheme = URL(string: value)?.scheme?.lowercased(),
               !["http", "https"].contains(scheme) { text = nil }
            if let text = text {
                self.load(jobs.dropFirst(), parts: parts + [text], owner: owner)
            } else if error != nil && (type == "public.url" || (jobs.count == 1 && parts.isEmpty)) {
                self.failed(SujiGroupError("分享来源未能提供完整内容，请重试。"))
            } else { self.load(jobs.dropFirst(), parts: parts, owner: owner) }
        }
    }

    private func failed(_ error: Error) {
        DispatchQueue.main.async {
            self.message.text = error.localizedDescription
            self.close.isHidden = false
        }
    }

    @objc private func finish() { extensionContext?.completeRequest(returningItems: nil) }
}
