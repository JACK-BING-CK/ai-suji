"""将两个扩展嵌入已有的 App-Plus iOS 离线工程。需要 pbxproj==4.3.3。"""

import argparse
import hashlib
import os
from pathlib import Path
import plistlib
import re

from openstep_parser import OpenStepDecoder
from pbxproj import XcodeProject


HERE = Path(__file__).resolve().parent
UTS = HERE.parents[1] / "src/uni_modules/suji-system/utssdk"
PRODUCT = "com.apple.product-type."
GROUP_KEY = "com.apple.security.application-groups"


def append_unique(items, value):
    if value not in items:
        items.append(value)


def write_plist(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(plistlib.dumps(value, sort_keys=False))


def read_plist(path):
    return plistlib.loads(path.read_bytes()) if path.exists() else {}


def integrate(args):
    project_file = args.project.resolve() / "project.pbxproj"
    root = project_file.parent.parent
    with project_file.open(encoding="utf-8") as parser:
        tree = OpenStepDecoder.ParseFromFile(parser)
    objects = tree["objects"]
    project = objects[tree["rootObject"]]
    host_id = next((key for key in project["targets"] if objects[key].get("name") == args.target), None)
    if not host_id or objects[host_id].get("productType") != PRODUCT + "application":
        raise ValueError("找不到指定的应用 target")
    host = objects[host_id]
    items = project.setdefault("attributes", {}).setdefault("TargetAttributes", {})
    host_configs = objects[host["buildConfigurationList"]]["buildConfigurations"]
    configs = {objects[c]["name"]: objects[c] for c in host_configs}
    project_configs = {objects[c]["name"]: objects[c]["buildSettings"]
                       for c in objects[project["buildConfigurationList"]]["buildConfigurations"]}
    generated_plists = {}

    def relative(path):
        return Path(os.path.relpath(path, root)).as_posix()

    def key(label):
        return hashlib.sha256((host_id + ":SujiSystem:" + label).encode()).hexdigest()[:24].upper()

    def put(label, isa, **fields):
        ident = key(label)
        objects[ident] = dict(isa=isa, **fields)
        return ident

    def settings_path(value):
        for var in ("$(SRCROOT)", "${SRCROOT}", "$(PROJECT_DIR)", "${PROJECT_DIR}"):
            value = value.replace(var, str(root))
        if "$" in value:
            raise ValueError(f"请先把工程中的路径变量展开为实际文件名：{value}")
        return root / value

    def capability(target_id):
        is_on = items.setdefault(target_id, {}).setdefault("SystemCapabilities", {})
        is_on["com.apple.ApplicationGroups.iOS"] = {"enabled": "1"}

    def referenced_plist(value, default_name, allow_generate):
        if value:
            path = settings_path(value)
            if not path.is_file():
                raise ValueError(f"工程引用的 plist 不存在：{path}")
        elif allow_generate:
            path = root / "SujiIntegration" / default_name
        else:
            raise ValueError("工程缺少 INFOPLIST_FILE，需要为宿主指定有效的 Info.plist")
        if path not in generated_plists:
            generated_plists[path] = read_plist(path)
        return path, generated_plists[path]

    versions = {}
    capability(host_id)
    for name, config in configs.items():
        host_settings = config["buildSettings"]
        source_settings = {**project_configs.get(name, {}), **host_settings}
        info_path, info = referenced_plist(source_settings.get("INFOPLIST_FILE"), "Host.Info.plist",
                                           source_settings.get("GENERATE_INFOPLIST_FILE") == "YES")
        ent_path, ent = referenced_plist(source_settings.get("CODE_SIGN_ENTITLEMENTS"), "Host.entitlements", True)
        append_unique(ent.setdefault(GROUP_KEY, []), "$(SUJI_APP_GROUP)")
        info["SujiAppGroup"] = "$(SUJI_APP_GROUP)"
        info["CFBundleIdentifier"] = "$(PRODUCT_BUNDLE_IDENTIFIER)"
        urls = info.setdefault("CFBundleURLTypes", [])
        if not any("aisuji" in group.get("CFBundleURLSchemes", []) for group in urls):
            urls.append({"CFBundleURLName": "AI速记小组件", "CFBundleURLSchemes": ["aisuji"]})
        versions[name] = {}
        for setting, field, default in (("MARKETING_VERSION", "CFBundleShortVersionString", "1.0"),
                                        ("CURRENT_PROJECT_VERSION", "CFBundleVersion", "1")):
            raw = info.get(field, f"$({setting})")
            versions[name][setting] = source_settings.get(setting, default) if raw == f"$({setting})" else raw
        host_settings.update(INFOPLIST_FILE=relative(info_path), CODE_SIGN_ENTITLEMENTS=relative(ent_path),
                             PRODUCT_BUNDLE_IDENTIFIER=args.bundle_id, SUJI_APP_GROUP=args.group,
                             DEVELOPMENT_TEAM=args.team)
        if args.host_profile:
            host_settings.update(CODE_SIGN_STYLE="Manual", PROVISIONING_PROFILE_SPECIFIER=args.host_profile)

    group_id = put("group", "PBXGroup", name="Suji System Extensions", sourceTree="<group>", children=[])
    append_unique(objects[project["mainGroup"]]["children"], group_id)
    product_group = objects[project.get("productRefGroup") or project["mainGroup"]]["children"]
    phase_id = put("embed", "PBXCopyFilesBuildPhase", name="Embed Suji App Extensions", dstPath="",
                   dstSubfolderSpec="13", buildActionMask="2147483647", runOnlyForDeploymentPostprocessing="0", files=[])
    append_unique(host["buildPhases"], phase_id)

    def ref(path, file_type):
        if not path.is_file():
            raise ValueError(f"缺少扩展源文件：{path}")
        ident = put(relative(path), "PBXFileReference", path=relative(path), name=path.name, sourceTree="SOURCE_ROOT",
                    lastKnownFileType=file_type)
        append_unique(objects[group_id]["children"], ident)
        return ident

    def phase(target, phase_type, references):
        files = [put(target + phase_type + r, "PBXBuildFile", fileRef=r) for r in references]
        return put(target + phase_type, phase_type, buildActionMask="2147483647",
                   runOnlyForDeploymentPostprocessing="0", files=files)

    shared = ref(UTS / "app-ios/SujiGroupStore.swift", "sourcecode.swift")
    sql = ref(UTS / "app-android/res/raw/suji_widget_today.sql", "text")
    ent_path = HERE / "System.entitlements"
    ref(ent_path, "text.plist.entitlements")
    for folder, target, source, suffix, version, profile in [
        ("Share", "SujiShare", "ShareViewController.swift", ".share", "12.0", args.share_profile),
        ("Widget", "SujiToday", "SujiToday.swift", ".today", "14.0", args.widget_profile),
    ]:
        target_id = key(target)
        if any(objects[t].get("name") == target and t != target_id for t in project["targets"]):
            raise ValueError(f"已有其他同名 target：{target}")
        plist_path = HERE / folder / "Info.plist"
        ref(plist_path, "text.plist.xml")
        swift = ref(HERE / folder / source, "sourcecode.swift")
        build_configs = []
        for name, config in configs.items():
            settings = dict(PRODUCT_BUNDLE_IDENTIFIER=args.bundle_id + suffix, PRODUCT_NAME="$(TARGET_NAME)",
                            DEVELOPMENT_TEAM=args.team, CODE_SIGN_STYLE="Manual" if profile else "Automatic",
                            CODE_SIGN_ENTITLEMENTS=relative(ent_path), INFOPLIST_FILE=relative(plist_path),
                            SUJI_APP_GROUP=args.group, SWIFT_VERSION="5.0", IPHONEOS_DEPLOYMENT_TARGET=version,
                            SDKROOT="iphoneos", SUPPORTED_PLATFORMS="iphoneos iphonesimulator",
                            TARGETED_DEVICE_FAMILY=config["buildSettings"].get("TARGETED_DEVICE_FAMILY", "1,2"),
                            LD_RUNPATH_SEARCH_PATHS=["$(inherited)", "@executable_path/../../Frameworks"],
                            OTHER_LDFLAGS=["$(inherited)", "-lsqlite3"], APPLICATION_EXTENSION_API_ONLY="YES",
                            SKIP_INSTALL="YES", **versions[name])
            if profile:
                settings["PROVISIONING_PROFILE_SPECIFIER"] = profile
            build_configs.append(put(target + name, "XCBuildConfiguration", name=name, buildSettings=settings))
        config_list = put(target + "configs", "XCConfigurationList", buildConfigurations=build_configs,
                          defaultConfigurationIsVisible="0",
                          defaultConfigurationName=objects[host["buildConfigurationList"]].get("defaultConfigurationName", "Release"))
        product = put(target + "product", "PBXFileReference", path=target + ".appex", sourceTree="BUILT_PRODUCTS_DIR",
                      explicitFileType="wrapper.app-extension", includeInIndex="0")
        append_unique(product_group, product)
        phases = [phase(target, "PBXSourcesBuildPhase", [shared, swift]), phase(target, "PBXFrameworksBuildPhase", []),
                  phase(target, "PBXResourcesBuildPhase", [sql] if folder == "Widget" else [])]
        put(target, "PBXNativeTarget", name=target, productName=target, productType=PRODUCT + "app-extension",
            productReference=product, buildConfigurationList=config_list, buildPhases=phases, buildRules=[], dependencies=[])
        capability(target_id)
        append_unique(project["targets"], target_id)
        proxy = put(target + "proxy", "PBXContainerItemProxy", containerPortal=tree["rootObject"], proxyType="1",
                    remoteGlobalIDString=target_id, remoteInfo=target)
        dependency = put(target + "dependency", "PBXTargetDependency", target=target_id, targetProxy=proxy)
        append_unique(host.setdefault("dependencies", []), dependency)
        embed = put(target + "embedded", "PBXBuildFile", fileRef=product, settings={"ATTRIBUTES": ["RemoveHeadersOnCopy"]})
        objects[phase_id]["files"].append(embed)

    output = repr(XcodeProject(tree, str(project_file))) + "\n"
    for path, data in generated_plists.items():
        write_plist(path, data)
    temp = project_file.with_suffix(".pbxproj.new")
    temp.write_text(output, encoding="utf-8")
    temp.replace(project_file)
    print("已接入 SujiShare 和 SujiToday，已嵌入宿主 PlugIns。")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("project", type=Path, help="宿主 .xcodeproj 路径")
    for arg in ("target", "bundle-id", "group", "team"):
        parser.add_argument("--" + arg, required=True)
    for arg in ("host-profile", "share-profile", "widget-profile"):
        parser.add_argument("--" + arg)
    args = parser.parse_args()
    if (not re.fullmatch(r"[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+", args.bundle_id)
            or not re.fullmatch(r"group(?:\.[A-Za-z0-9-]+)+", args.group)
            or not re.fullmatch(r"[A-Za-z0-9]{10}", args.team)):
        parser.error("Bundle ID、App Group 或十位 Team ID 格式错误")
    integrate(args)
