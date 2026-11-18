import base64
import json
import re
import shutil
import subprocess
import tempfile
import tomllib
from pathlib import Path
from urllib.parse import quote, unquote, urlsplit

PRODUCT = "Mini MQTT Client"
APP = "mini-mqtt-client"
CONFIG = "src-tauri/tauri.conf.json"
RUNNERS = {"windows": "windows-latest", "linux": "ubuntu-22.04", "macos": "macos-15"}
TARGETS = {
    "windows": ("windows-x86_64",),
    "linux": ("linux-x86_64",),
    "macos": ("darwin-x86_64", "darwin-aarch64"),
}
INSTALLERS = {
    "nsis": "nsis", "msi": "msi", "appimage": "appimage",
    "deb": "deb", "rpm": "rpm", "macos": "app",
}
DEFAULT_BUNDLES = {"nsis", "appimage", "macos"}
VERSION = re.compile(
    r"v(?P<core>(?:0|[1-9][0-9]*)(?:\.(?:0|[1-9][0-9]*)){2})"
    r"(?:-(?P<pre>[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?"
    r"(?:\+(?P<build>[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?"
)
ASSET_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._+ -]*")


def parse_tag(tag):
    match = VERSION.fullmatch(tag)
    if not match or any(
        re.fullmatch(r"0[0-9]+", part) for part in (match["pre"] or "").split(".")
    ):
        raise ValueError(f"Expected a v-prefixed SemVer tag, got {tag!r}")
    return match


def platforms(selection):
    if selection == "all":
        return tuple(RUNNERS)
    if selection not in RUNNERS:
        raise ValueError(f"Invalid platform selection: {selection!r}")
    return (selection,)


def validate_event(event, ref, default_branch, tag, selection):
    parse_tag(tag)
    platforms(selection)
    if event == "push" and ref == f"refs/tags/{tag}" and selection == "all":
        return
    if event == "workflow_dispatch" and ref == f"refs/heads/{default_branch}":
        return
    raise ValueError("Release builds require a tag push or dispatch from the default branch")


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8"))


def validate_versions(source, tag):
    parse_tag(tag)
    package = read_json(source / "package.json")
    npm_lock = read_json(source / "package-lock.json")
    manifest = tomllib.loads((source / "src-tauri/Cargo.toml").read_text(encoding="utf-8"))
    cargo_lock = tomllib.loads((source / "src-tauri/Cargo.lock").read_text(encoding="utf-8"))
    own_crates = [crate for crate in cargo_lock["package"]
                  if crate["name"] == APP and "source" not in crate]
    config = read_json(source / CONFIG)
    versions = {
        "package.json": package.get("version"),
        "package-lock.json": npm_lock.get("version"),
        "package-lock.json root": npm_lock["packages"][""].get("version"),
        "Cargo.toml": manifest["package"].get("version"),
        "Cargo.lock": own_crates[0].get("version") if len(own_crates) == 1 else None,
        "tauri.conf.json": config.get("version"),
    }
    for file, version in versions.items():
        if version != tag[1:]:
            raise ValueError(f"{file} has version {version!r}, expected {tag[1:]}")
    if config.get("productName") != PRODUCT or config["bundle"].get("createUpdaterArtifacts") is not True:
        raise ValueError("Tag must use the project's product name and Tauri v2 updater bundles")


def bundle_files(tag, platform):
    version = tag[1:]
    if platform == "windows":
        return {
            "nsis": (f"{PRODUCT}_{version}_x64-setup.exe", True),
            "msi": (f"{PRODUCT}_{version}_x64_en-US.msi", True),
        }
    if platform == "linux":
        bundles = {
            "appimage": (f"{PRODUCT}_{version}_amd64.AppImage", True),
            "deb": (f"{PRODUCT}_{version}_amd64.deb", True),
            "rpm": (f"{PRODUCT}-{version}-1.x86_64.rpm", True),
        }
        parsed = parse_tag(tag)
        # Keep SemVer prereleases out of native package-manager version ordering.
        return {"appimage": bundles["appimage"]} if parsed["pre"] or parsed["build"] else bundles
    if platform == "macos":
        return {
            "macos": (f"{PRODUCT}.app.tar.gz", True),
            "dmg": (f"{PRODUCT}_{version}_universal.dmg", False),
        }
    raise ValueError(f"Unknown platform {platform!r}")


def asset_name(tag, folder, name):
    if folder == "macos":
        name = name.replace(".app.tar.gz", f"_{tag[1:]}_universal.app.tar.gz", 1)
    return name.replace(" ", ".").replace("+", "_")


def require_file(file):
    if file.is_symlink() or not file.is_file() or not file.stat().st_size:
        raise ValueError(f"Missing or empty release file: {file}")


def verify_file_set(directory, expected):
    if directory.is_symlink() or not directory.is_dir():
        raise ValueError(f"Missing platform artifact: {directory}")
    for name in expected:
        require_file(directory / name)
    unexpected = {file.name for file in directory.iterdir()} - set(expected)
    if unexpected:
        raise ValueError(f"Unexpected release files in {directory}: {sorted(unexpected)}")


def collect(tag, platform, bundle, output):
    parse_tag(tag)
    output.mkdir()
    for folder, (name, signed) in bundle_files(tag, platform).items():
        directory = bundle / folder
        names = [name, name + ".sig"] if signed else [name]
        for file in names:
            require_file(directory / file)
        suffix = ".app.tar.gz" if folder == "macos" else Path(name).suffix
        candidates = {file.name for file in directory.iterdir()
                      if file.name.endswith((suffix, suffix + ".sig"))}
        if directory.is_symlink() or candidates != set(names):
            raise ValueError(f"Unexpected {platform} bundles in {directory}: {sorted(candidates)}")
        for file in names:
            shutil.copyfile(directory / file, output / asset_name(tag, folder, file))


def verify_signature(public_key, bundle, signature):
    with tempfile.NamedTemporaryFile() as decoded:
        decoded.write(base64.b64decode(signature, validate=True))
        decoded.flush()
        subprocess.run(
            ["minisign", "-Vm", str(bundle), "-x", decoded.name, "-P", public_key, "-q"],
            check=True,
        )


def asset_url(repo, tag, name):
    return f"https://github.com/{repo}/releases/download/{quote(tag, safe='')}/{quote(name, safe='')}"


def validate_artifacts(root, selected, tag, repo, verify):
    expected_dirs = {f"release-{platform}" for platform in selected}
    if root.is_symlink() or not root.is_dir() or {entry.name for entry in root.iterdir()} != expected_dirs:
        raise ValueError(f"Expected platform artifacts {sorted(expected_dirs)} in {root}")
    assets, entries = {}, {}
    for platform in selected:
        directory = root / f"release-{platform}"
        bundles = {asset_name(tag, folder, name): (folder, signed)
                   for folder, (name, signed) in bundle_files(tag, platform).items()}
        expected = list(bundles) + [name + ".sig" for name, (_, signed) in bundles.items() if signed]
        verify_file_set(directory, expected)
        for name, (folder, signed) in bundles.items():
            if signed:
                signature = (directory / (name + ".sig")).read_text(encoding="utf-8").strip()
                if not signature:
                    raise ValueError(f"Empty updater signature for {name}")
                verify(directory / name, signature)
                entry = {"url": asset_url(repo, tag, name), "signature": signature}
                for target in TARGETS[platform]:
                    entries[f"{target}-{INSTALLERS[folder]}"] = entry
                    if folder in DEFAULT_BUNDLES:
                        entries[target] = entry
        for name in expected:
            if name in assets:
                raise ValueError(f"Duplicate release asset {name}")
            assets[name] = directory / name
    return assets, entries


def merge_manifest(old, updates, repo, tag, existing_names, notes, date):
    if old and old.get("version", "").removeprefix("v") != tag[1:]:
        raise ValueError("Existing latest.json has a different version")
    # Preserve any legacy keys for unmodified assets.
    entries = {target: entry for target, entry in old.get("platforms", {}).items()
               if target not in updates}
    extensions = {
        "windows": (".exe", ".msi", ".nsis.zip", ".msi.zip"),
        "linux": (".AppImage", ".AppImage.tar.gz", ".deb", ".rpm"),
        "darwin": (".app.tar.gz",),
    }
    for target, entry in entries.items():
        url = urlsplit(entry["url"])
        prefix = f"/{repo}/releases/download/{tag}/"
        path = unquote(url.path)
        name = path.removeprefix(prefix)
        if (url.scheme != "https" or url.netloc != "github.com" or url.query or url.fragment
                or not path.startswith(prefix) or not ASSET_NAME.fullmatch(name)
                or name not in existing_names or not entry["signature"].strip()
                or not name.endswith(extensions.get(target.split("-")[0], ()))):
            raise ValueError(f"Invalid existing updater entry for {target!r}")
    entries.update(updates)
    return {"version": tag[1:], "notes": old.get("notes", notes),
            "pub_date": old.get("pub_date", date), "platforms": entries}


def should_make_latest(tag, current):
    version = parse_tag(tag)
    if version["pre"]:
        return False
    if current is None:
        return True
    current_version = parse_tag(current)
    core = tuple(map(int, version["core"].split(".")))
    current_core = tuple(map(int, current_version["core"].split(".")))
    return core > current_core
