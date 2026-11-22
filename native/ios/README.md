# iOS 分享与桌面组件

分享扩展支持选中文字和网页链接。选择「AI速记」后，扩展把原文、接收时的账号及 UUID 提交到 App Group 的 SQLite，再返回来源应用。此操作支持断网。iOS 分享扩展不能自行唤醒宿主，想法在下次进入 AI速记时自动导入本地收集箱。SQLite 导入成功后才会确认消费。第一次启动前收到的分享由本机首次建立的账号认领。

中号与大号桌面组件支持逐行链接。组件从共享 SQLite 读取当前账号的前三条待办。点击行会打开对应日期的日程实例，点击「记一笔」打开记录页。宿主更新投影后请求 WidgetKit 刷新；午夜后的条目由组件自身的本地时间线提供。实际桌面换图时间由 iOS 安排。[Apple 扩展生命周期](https://developer.apple.com/library/archive/documentation/General/Conceptual/ExtensibilityPG/ExtensionOverview.html) · [WidgetKit 时间线](https://developer.apple.com/documentation/widgetkit/keeping-a-widget-up-to-date)

## 接入已有宿主

1. 在 Mac 用版本匹配的 HBuilderX 与 App-Plus 离线 SDK 导出资源和 `suji-system` 插件。使用 5.13 及以上版本的示例工程时，将导出目录 `uni_modules/suji-system/app-ios` 放入 `HBuilder-Hello/UTSPlugins/suji-system/app-ios`，在 Podfile 启用 `UTS` 并执行 `pod install`。较早版本按官方文档的手动方式链接 UTS 基础模块和生成的插件。Xcode 工程和本仓库须保留在构建机，两个扩展通过相对路径引用 Swift、plist 和共用 SQL。[DCloud iOS 离线集成](https://nativesupport.dcloud.net.cn/AppDocs/usesdk/ios) · [iOS UTS 插件集成](https://nativesupport.dcloud.net.cn/AppDocs/usemodule/iOSModuleConfig/uts.html)
2. 在 Apple Developer 的 Identifiers 中为宿主和两个扩展登记同一 Team 的显式 App ID。扩展 ID 分别是宿主 Bundle ID 加 `.share`、`.today`。创建一个 App Group，并在三个 ID 上都启用同一 Group。自动签名需要 Xcode 登录具备相应权限的开发者账号；手动签名需分别准备包含该组的三个描述文件。[Apple App Groups](https://developer.apple.com/documentation/xcode/configuring-app-groups)
3. 在仓库根目录执行下列命令，把示例路径和签名标识换为自己的值。

```sh
python3 -m venv /tmp/suji-ios-tools
/tmp/suji-ios-tools/bin/pip install pbxproj==4.3.3
/tmp/suji-ios-tools/bin/python native/ios/integrate.py /path/to/Host.xcodeproj \
  --target Host --bundle-id com.example.suji --group group.com.example.suji --team TEAMID1234
```

脚本保留宿主现有 URL Scheme 和 entitlements，登记 `aisuji`，配置三个 target 的 App Groups，添加 `SujiShare` 和 `SujiToday`、两条构建依赖以及 Embed App Extensions 阶段。可重复执行。手动签名时追加 `--host-profile`、`--share-profile`、`--widget-profile` 和各自的描述文件名称。多个构建配置引用不同 Info.plist 或 entitlements 时，脚本逐一合并。请在版本控制内检查接入后的宿主工程差异。

4. 在 Xcode 确认宿主的 Signing & Capabilities 及两个扩展的 Team/App Group 一致。用宿主 scheme 构建安装。Share 支持 iOS 12 及以上，WidgetKit 桌面组件支持 iOS 14 及以上。若工程使用 CocoaPods，请用原来的 workspace 和 scheme。

```sh
xcodebuild -project /path/to/Host.xcodeproj -scheme Host \
  -destination 'generic/platform=iOS' -archivePath /tmp/AI-Suji.xcarchive archive
ls /tmp/AI-Suji.xcarchive/Products/Applications/*.app/PlugIns/
```

归档包应同时含 `SujiShare.appex` 和 `SujiToday.appex`。宿主及两个扩展的签名授权中都应包含实际配置的组，可用 `codesign -d --entitlements :- <app或appex路径>` 核对。

## iPhone 验收

Windows 已验证 UTS 转 Swift、Swift 语法、plist 和临时 Xcode 工程重复接入。Xcode 编译签名和以下 iPhone 操作待验。

- 打开并关闭一次 AI速记。断网后从 Safari 分享完整网页 URL，再从备忘录分享文字。结束宿主进程再打开，收集箱应出现两条 `source=share` 的原文；再次启动条数应保持一致。
- 切换账号后查看小组件，确认只出现当前账号的待办。分享接收后、导入前切换账号，回到原账号验证只导入一次。
- 添加中号组件，准备超过三条待办及一条跨午夜的重复日程。逐行点击并核对被打开的日程、日期，再点「记一笔」检查记录页。保持宿主关闭并跨过本地午夜核对新日期条目。
