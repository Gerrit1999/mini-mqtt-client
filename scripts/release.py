import argparse
import hashlib
import json
import os
import re
import subprocess
import tempfile
from base64 import b64decode
from contextlib import nullcontext
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import quote
from urllib.request import HTTPRedirectHandler, Request, build_opener

from release_artifacts import (
    ASSET_NAME, CONFIG, RUNNERS, collect, merge_manifest, parse_tag, platforms,
    read_json, should_make_latest, validate_artifacts, validate_event, validate_versions,
    verify_signature,
)

MANIFEST = "latest.json"
CHECKSUMS = "SHA256SUMS.txt"
METADATA = {name + suffix for name in (MANIFEST, CHECKSUMS)
            for suffix in ("", ".pending", ".previous")}


class AssetRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        redirected = super().redirect_request(req, fp, code, msg, headers, newurl)
        if redirected:
            redirected.remove_header("Authorization")
        return redirected


class GitHub:
    def __init__(self, repo, token):
        if not re.fullmatch(r"[A-Za-z0-9_-]+/[A-Za-z0-9_.-]+", repo):
            raise ValueError(f"Invalid GitHub repository: {repo!r}")
        self.repo = repo
        self.token = token
        self.opener = build_opener(AssetRedirect())

    def request(self, path, method="GET", *, data=None, file=None, download=False):
        server = "uploads.github.com" if file is not None else "api.github.com"
        headers = {
            "Authorization": f"Bearer {self.token}",
            "Accept": "application/octet-stream" if download else "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        }
        if data is not None:
            data = json.dumps(data).encode()
            headers["Content-Type"] = "application/json"
        if file is not None:
            headers["Content-Length"] = str(file.stat().st_size)
            headers["Content-Type"] = "application/octet-stream"
        url = f"https://{server}/repos/{self.repo}{path}"
        with file.open("rb") if file is not None else nullcontext(data) as stream:
            return self.opener.open(
                Request(url, data=stream, headers=headers, method=method),
                timeout=120,
            )

    def api(self, path, method="GET", *, data=None, file=None, missing=False):
        try:
            with self.request(path, method, data=data, file=file) as response:
                return None if response.status == 204 else json.load(response)
        except HTTPError as error:
            if missing and error.code == 404:
                return None
            raise ValueError(f"GitHub {method} {path}: {error.code} {error.read().decode()}") from error

    def pages(self, path):
        for page in range(1, 1001):
            items = self.api(f"{path}?per_page=100&page={page}")
            yield from items
            if len(items) < 100:
                return
        raise ValueError(f"Too many GitHub results for {path}")

    def check_tag(self, tag, commit):
        obj = self.api(f"/git/ref/tags/{quote(tag, safe='')}")["object"]
        while obj["type"] == "tag":
            obj = self.api(f"/git/tags/{obj['sha']}")["object"]
        if obj["type"] != "commit" or obj["sha"] != commit:
            raise ValueError(f"{tag} no longer points at the built commit {commit}")

    def digest(self, asset):
        digest = asset.get("digest") or ""
        if re.fullmatch(r"sha256:[0-9a-f]{64}", digest):
            return digest.removeprefix("sha256:")
        with self.request(f"/releases/assets/{asset['id']}", download=True) as response:
            return hashlib.file_digest(response, "sha256").hexdigest()

    def read_manifest(self, asset):
        with self.request(f"/releases/assets/{asset['id']}", download=True) as response:
            return json.load(response)

    def read_signature(self, asset):
        with self.request(f"/releases/assets/{asset['id']}", download=True) as response:
            data = response.read(16385)
        if len(data) > 16384:
            raise ValueError("Existing signature is too large")
        return data.decode("utf-8").strip()

    def upload(self, release, name, file):
        asset = self.api(f"/releases/{release['id']}/assets?name={quote(name, safe='')}",
                         "POST", file=file)
        if asset["name"] != name or asset["state"] != "uploaded" or asset["size"] != file.stat().st_size:
            raise ValueError(f"GitHub did not store asset {name} as requested")
        return asset

    def delete(self, asset):
        self.api(f"/releases/assets/{asset['id']}", "DELETE")

    def rename(self, asset, name):
        renamed = self.api(f"/releases/assets/{asset['id']}", "PATCH", data={"name": name})
        if renamed["name"] != name:
            raise ValueError(f"GitHub did not rename asset to {name}")
        return renamed


def sha256(file):
    with file.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def plan_uploads(existing, incoming, draft, digest):
    """Check every collision before changing the release."""
    hashes, uploads = {}, []
    for name, file in incoming.items():
        old = existing.get(name)
        hashes[name] = sha256(file)
        if old is not None and old["state"] == "uploaded":
            if digest(old) == hashes[name]:
                continue
            if not draft:
                raise ValueError(f"Published asset {name} has different content. Release a new version.")
        elif old is not None and (old["state"] != "starter" or old["size"] != 0):
            raise ValueError(f"Unexpected state for existing asset {name}")
        uploads.append((name, file, old))
    for name, asset in existing.items():
        if name in METADATA or name in hashes:
            continue
        if asset["state"] != "uploaded" or not ASSET_NAME.fullmatch(name):
            raise ValueError(f"Cannot include existing asset {name!r} in checksums")
        hashes[name] = digest(asset)
    return uploads, hashes


def replace_metadata(api, release, existing, file):
    # GitHub has no atomic asset replacement. Stage bytes first and retain the
    # previous asset until the new name is live, so a release-job retry can recover.
    name = file.name
    current = existing.get(name)
    backup = existing.get(name + ".previous")
    pending = existing.get(name + ".pending")
    if current and current["state"] != "uploaded":
        api.delete(current)
        current = None
    if not current or api.digest(current) != sha256(file):
        if pending:
            api.delete(pending)
            pending = None
        staged = api.upload(release, name + ".pending", file)
        if current:
            if backup:
                api.delete(backup)
            backup = api.rename(current, name + ".previous")
        api.rename(staged, name)
    if pending:
        api.delete(pending)
    if backup:
        api.delete(backup)


def retain_public_signatures(api, existing, incoming, updates, public_key):
    """A fresh signing timestamp must not replace an already valid public signature."""
    incoming = dict(incoming)
    for name, file in list(incoming.items()):
        signature_name = name + ".sig"
        old, old_signature = existing.get(name), existing.get(signature_name)
        if (signature_name not in incoming or not old or not old_signature
                or old["state"] != "uploaded" or old_signature["state"] != "uploaded"
                or api.digest(old) != sha256(file)):
            continue
        signature = api.read_signature(old_signature)
        verify_signature(public_key, file, signature)
        del incoming[signature_name]
        for entry in updates.values():
            if entry["url"].endswith("/" + quote(name, safe="")):
                entry["signature"] = signature
    return incoming


def publish(api, source, tag, commit, selection, artifacts, repair):
    version = parse_tag(tag)
    selected = platforms(selection)
    if not repair and selection != "all":
        raise ValueError("A tag push must build all three platforms")
    api.check_tag(tag, commit)
    release = next((item for item in api.pages("/releases") if item["tag_name"] == tag), None)
    if release and not release["draft"] and not repair:
        print(f"{tag} is already public")
        return
    if repair and (not release or release.get("immutable")):
        raise ValueError("Repair requires an existing, editable release")
    pre = version["pre"] is not None
    if release and not repair and release["prerelease"] != pre:
        raise ValueError("Draft prerelease state disagrees with the tag")

    if repair and not release["draft"]:
        # Restore a previously valid fixed URL before a new rebuild can fail checks.
        assets = {asset["name"]: asset for asset in api.pages(f"/releases/{release['id']}/assets")}
        for name in (MANIFEST, CHECKSUMS):
            backup = assets.get(name + ".previous")
            if name not in assets and backup and backup["state"] == "uploaded":
                api.rename(backup, name)

    pubkey = read_json(source / CONFIG)["plugins"]["updater"]["pubkey"]
    public_key = b64decode(pubkey, validate=True).decode().splitlines()[1]
    incoming, updates = validate_artifacts(
        artifacts, selected, tag, api.repo,
        lambda file, signature: verify_signature(public_key, file, signature),
    )
    if not release:
        notes = source / ".github/release-notes" / f"{tag}.md"
        request = {"tag_name": tag, "target_commitish": commit, "name": tag,
                   "draft": True, "prerelease": pre, "make_latest": "false"}
        if notes.is_file():
            request["body"] = notes.read_text(encoding="utf-8")
        else:
            request["generate_release_notes"] = True
        release = api.api("/releases", "POST", data=request)

    release_path = f"/releases/{release['id']}"
    assets = list(api.pages(release_path + "/assets"))
    existing = {asset["name"]: asset for asset in assets}
    if len(existing) != len(assets):
        raise ValueError("Release contains duplicate asset names")
    if repair and not release["draft"]:
        incoming = retain_public_signatures(api, existing, incoming, updates, public_key)
    uploads, hashes = plan_uploads(existing, incoming, release["draft"], api.digest)

    old = {}
    if repair:
        for name in (MANIFEST, MANIFEST + ".previous"):
            if name in existing and existing[name]["state"] == "uploaded":
                old = api.read_manifest(existing[name])
                break
    replaced = {name for name, _, _ in uploads}
    unchanged = {name for name, asset in existing.items()
                 if asset["state"] == "uploaded" and name not in replaced}
    manifest = merge_manifest(
        old, updates, api.repo, tag, unchanged,
        release.get("body") or "", release.get("published_at") or release["created_at"],
    )
    with tempfile.TemporaryDirectory() as tmp:
        latest = Path(tmp) / MANIFEST
        latest.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        hashes[MANIFEST] = sha256(latest)
        sums = Path(tmp) / CHECKSUMS
        sums.write_text("".join(f"{digest}  {name}\n" for name, digest in sorted(hashes.items())),
                        encoding="utf-8")
        hashes[CHECKSUMS] = sha256(sums)
        for name, file, old_asset in uploads:
            if old_asset:
                api.delete(old_asset)
            api.upload(release, name, file)
        replace_metadata(api, release, existing, latest)
        replace_metadata(api, release, existing, sums)

    final = list(api.pages(release_path + "/assets"))
    if len(final) != len(hashes) or {asset["name"] for asset in final} != set(hashes):
        raise ValueError("Release asset list changed during publication")
    for asset in final:
        digest = asset.get("digest")
        if asset["state"] != "uploaded" or (digest and digest != "sha256:" + hashes[asset["name"]]):
            raise ValueError(f"Unexpected state or checksum for {asset['name']}")

    api.check_tag(tag, commit)
    if not repair:
        current = api.api("/releases/latest", missing=True)
        latest = should_make_latest(tag, current["tag_name"] if current else None)
        api.check_tag(tag, commit)
        api.api(release_path, "PATCH",
                data={"draft": False, "make_latest": "true" if latest else "false"})


def write_outputs(outputs):
    with Path(os.environ["GITHUB_OUTPUT"]).open("a", encoding="utf-8") as stream:
        for key, value in outputs.items():
            print(f"{key}={value}", file=stream)


def main():
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest="command", required=True)
    inputs = commands.add_parser("inputs")
    inputs.add_argument("tag")
    inputs.add_argument("platform")
    inputs.add_argument("default_branch")
    source = commands.add_parser("source")
    source.add_argument("tag")
    source.add_argument("source", type=Path)
    stage = commands.add_parser("collect")
    stage.add_argument("tag")
    stage.add_argument("platform")
    stage.add_argument("bundle", type=Path)
    stage.add_argument("output", type=Path)
    release = commands.add_parser("publish")
    release.add_argument("tag")
    release.add_argument("commit")
    release.add_argument("platform")
    release.add_argument("artifacts", type=Path)
    release.add_argument("--repair", action="store_true")
    release.add_argument("--source", type=Path, default=Path("."))
    args = parser.parse_args()

    if args.command == "inputs":
        validate_event(os.environ["GITHUB_EVENT_NAME"], os.environ["GITHUB_REF"],
                       args.default_branch, args.tag, args.platform)
        write_outputs({"tag": args.tag, "platform": args.platform,
                       "matrix": json.dumps([{"platform": p, "runner": RUNNERS[p]}
                                             for p in platforms(args.platform)])})
    elif args.command == "source":
        validate_versions(args.source, args.tag)
        commit = subprocess.check_output(
            ["git", "-C", str(args.source), "rev-parse", "HEAD"], text=True,
        ).strip()
        version = parse_tag(args.tag)
        # WiX requires a numeric ProductVersion, while the app keeps its full SemVer.
        wix = (json.dumps({"bundle": {"windows": {"wix": {"version": version["core"]}}}})
               if version["pre"] or version["build"] else "")
        write_outputs({"commit": commit, "wix": wix})
    elif args.command == "collect":
        collect(args.tag, args.platform, args.bundle, args.output)
    else:
        github = GitHub(os.environ["GITHUB_REPOSITORY"], os.environ["GH_TOKEN"])
        publish(github, args.source, args.tag, args.commit, args.platform, args.artifacts, args.repair)


if __name__ == "__main__":
    main()
