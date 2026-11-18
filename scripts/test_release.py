import base64
import hashlib
import json
import re
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import release
from release_artifacts import (
    asset_name, asset_url, bundle_files, collect, merge_manifest, parse_tag, platforms,
    should_make_latest, validate_artifacts, validate_event, validate_versions, verify_signature,
)

TAG = "v1.8.3"
REPO = "Gerrit1999/mini-mqtt-client"
SOURCE = Path(__file__).resolve().parent.parent
APPIMAGE = "Mini.MQTT.Client_1.8.3_amd64.AppImage"
DATE = "2026-01-01T00:00:00Z"


def artifact_fixtures(root, tag=TAG, selected="all"):
    for platform in platforms(selected):
        folder = root / f"release-{platform}"
        folder.mkdir(parents=True)
        for kind, (raw, signed) in bundle_files(tag, platform).items():
            name = asset_name(tag, kind, raw)
            (folder / name).write_text(name, encoding="utf-8")
            if signed:
                (folder / (name + ".sig")).write_text(f"sig:{name}", encoding="utf-8")


def verify_fixture(file, signature):
    if signature.split("|", 1)[0] != f"sig:{file.name}":
        raise ValueError("Signature does not match fixture")


class FakeGitHub:
    repo = REPO

    def __init__(self, tag=TAG, state=None, latest=None):
        self.release = ({"id": 1, "tag_name": tag, "created_at": DATE, "body": "notes",
                         "draft": state[0], "prerelease": state[1]} if state else None)
        self.latest = latest
        self.assets = {}
        self.writes = []

    def check_tag(self, tag, commit):
        if commit != "a" * 40:
            raise ValueError("Tag changed")

    def pages(self, path):
        if path == "/releases":
            return [self.release] if self.release else []
        return list(self.assets.values())

    def api(self, path, method="GET", *, data=None, missing=False):
        if path == "/releases/latest":
            return {"tag_name": self.latest} if self.latest else None
        self.writes.append((method, path, data))
        if method == "POST":
            self.release = {"id": 1, "created_at": DATE, "body": "generated", **data}
            return self.release
        self.release.update(data)
        return self.release

    def add(self, name, content):
        asset = {"name": name, "state": "uploaded", "size": len(content), "content": content}
        self.assets[name] = asset
        return asset

    def upload(self, release, name, file):
        self.writes.append(("upload", name))
        return self.add(name, file.read_bytes())

    def read_manifest(self, asset):
        return json.loads(asset["content"])

    def read_signature(self, asset):
        return asset["content"].decode().strip()

    def digest(self, asset):
        return hashlib.sha256(asset["content"]).hexdigest()

    def delete(self, asset):
        self.writes.append(("delete", asset["name"]))
        del self.assets[asset["name"]]

    def rename(self, asset, name):
        self.writes.append(("rename", asset["name"], name))
        del self.assets[asset["name"]]
        return self.add(name, asset["content"])


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.artifacts = self.root / "artifacts"

    def publish(self, api, tag=TAG, selection="all", repair=False, commit="a" * 40, source=SOURCE):
        with patch("release.verify_signature", side_effect=lambda key, file, sig: verify_fixture(file, sig)):
            release.publish(api, source, tag, commit, selection, self.artifacts, repair)

    def test_tag_event_and_platform_inputs(self):
        for tag in ("../v1.2.3", "refs/tags/v1.2.3", "v1.2.03", "v1.2.3-01",
                    "v1.2.3\n", "v1.2.3$(id)", "v1.2.3+build/foo"):
            with self.subTest(tag=tag), self.assertRaisesRegex(ValueError, "SemVer"):
                parse_tag(tag)
        for ref in ("refs/tags/v1.8.2", "refs/heads/feature", "refs/heads/main-old"):
            with self.subTest(ref=ref), self.assertRaisesRegex(ValueError, "default branch"):
                validate_event("workflow_dispatch", ref, "main", TAG, "windows")
        with self.assertRaisesRegex(ValueError, "platform"):
            validate_event("workflow_dispatch", "refs/heads/main", "main", TAG, "linux,windows")
        validate_event("workflow_dispatch", "refs/heads/main", "main", "v1.8.2", "macos")
        validate_event("push", f"refs/tags/{TAG}", "main", TAG, "all")

    def test_every_version_source_must_match(self):
        version = "1.8.3"
        paths = {
            "package.json": '{"version": "1.8.3"}',
            "package-lock.json": '{"version": "1.8.3", "packages": {"": {"version": "1.8.3"}}}',
            "src-tauri/Cargo.toml": '[package]\nname = "mini-mqtt-client"\nversion = "1.8.3"',
            "src-tauri/Cargo.lock": '[[package]]\nname = "dep"\nversion = "0.1.0"\n'
                                   '[[package]]\nname = "mini-mqtt-client"\nversion = "1.8.3"',
            "src-tauri/tauri.conf.json": '{"version": "1.8.3", "productName": "Mini MQTT Client", '
                                        '"bundle": {"createUpdaterArtifacts": true}}',
        }
        (self.root / "src-tauri").mkdir()
        for path, content in paths.items():
            (self.root / path).write_text(content)
        validate_versions(self.root, TAG)
        for path, content in paths.items():
            for match in re.finditer(re.escape(version), content):
                mutated = content[:match.start()] + "1.8.4" + content[match.end():]
                (self.root / path).write_text(mutated)
                with self.subTest(path=path, offset=match.start()), self.assertRaisesRegex(ValueError, Path(path).name):
                    validate_versions(self.root, TAG)
                (self.root / path).write_text(content)

    def test_missing_platform_or_invalid_signature_never_creates_release(self):
        api = FakeGitHub()
        artifact_fixtures(self.artifacts, selected="linux")
        with self.assertRaisesRegex(ValueError, "platform artifacts"):
            self.publish(api)
        shutil.rmtree(self.artifacts)
        artifact_fixtures(self.artifacts)
        signature = self.artifacts / "release-linux" / (APPIMAGE + ".sig")
        signature.unlink()
        with self.assertRaisesRegex(ValueError, "Missing or empty"):
            self.publish(api)
        signature.write_text(" \n")
        with self.assertRaisesRegex(ValueError, "Empty updater signature"):
            self.publish(api)
        signature.write_text("sig:wrong-app.exe")
        with self.assertRaisesRegex(ValueError, "Signature does not match"):
            self.publish(api)
        self.assertEqual(api.writes, [])

    def test_unexpected_version_platform_and_symlink(self):
        artifact_fixtures(self.artifacts, selected="linux")
        folder = self.artifacts / "release-linux"
        for name in ("Mini.MQTT.Client_1.8.2_amd64.AppImage", "Mini.MQTT.Client_1.8.3_x64-setup.exe"):
            unexpected = folder / name
            unexpected.touch()
            with self.assertRaisesRegex(ValueError, "Unexpected release files"):
                validate_artifacts(self.artifacts, ("linux",), TAG, REPO, verify_fixture)
            unexpected.unlink()
        file = folder / APPIMAGE
        target = self.root / "outside"
        file.rename(target)
        file.symlink_to(target)
        with self.assertRaisesRegex(ValueError, "Missing or empty"):
            validate_artifacts(self.artifacts, ("linux",), TAG, REPO, verify_fixture)

    def test_collect_rejects_duplicate_candidates(self):
        bundle = self.root / "bundle"
        for folder, (name, signed) in bundle_files(TAG, "macos").items():
            (bundle / folder).mkdir(parents=True)
            (bundle / folder / name).write_text("app")
            if signed:
                (bundle / folder / (name + ".sig")).write_text("signature")
        collect(TAG, "macos", bundle, self.root / "collected")
        self.assertTrue((self.root / "collected" / "Mini.MQTT.Client_1.8.3_universal.app.tar.gz.sig").is_file())
        (bundle / "macos" / "other.app.tar.gz").touch()
        with self.assertRaisesRegex(ValueError, "Unexpected macos bundles"):
            collect(TAG, "macos", bundle, self.root / "duplicates")

    def test_full_publish_checksums_and_universal(self):
        api = FakeGitHub(latest="v1.8.2")
        artifact_fixtures(self.artifacts)
        self.publish(api)
        self.assertEqual(api.writes[0][0:2], ("POST", "/releases"))
        self.assertTrue(api.writes[0][2]["draft"])
        self.assertTrue(api.writes[0][2]["generate_release_notes"])
        self.assertEqual(api.writes[-1], ("PATCH", "/releases/1", {"draft": False, "make_latest": "true"}))
        manifest = api.read_manifest(api.assets["latest.json"])["platforms"]
        self.assertEqual(manifest["darwin-x86_64"], manifest["darwin-aarch64"])
        self.assertTrue(manifest["darwin-x86_64"]["url"].endswith("_universal.app.tar.gz"))
        self.assertTrue(manifest["windows-x86_64"]["url"].endswith("-setup.exe"))
        self.assertTrue(manifest["linux-x86_64"]["url"].endswith(".AppImage"))
        self.assertTrue(manifest["linux-x86_64-deb"]["url"].endswith(".deb"))
        checksum_text = api.assets["SHA256SUMS.txt"]["content"].decode()
        checksums = dict(line.split("  ", 1)[::-1] for line in checksum_text.splitlines())
        self.assertEqual(checksums, {name: api.digest(asset) for name, asset in api.assets.items()
                                     if name != "SHA256SUMS.txt"})
        api.writes.clear()
        self.publish(api)
        self.assertEqual(api.writes, [])

    def test_prerelease_uses_custom_notes_and_never_becomes_latest(self):
        tag = "v2.0.0-rc.1+build.5"
        api = FakeGitHub(tag, latest=TAG)
        artifact_fixtures(self.artifacts, tag)
        (self.root / "src-tauri").mkdir()
        shutil.copy(SOURCE / "src-tauri/tauri.conf.json", self.root / "src-tauri")
        notes = self.root / ".github/release-notes"
        notes.mkdir(parents=True)
        (notes / f"{tag}.md").write_text("Custom release notes", encoding="utf-8")
        self.publish(api, tag=tag, source=self.root)
        self.assertTrue(api.release["prerelease"])
        self.assertEqual(api.release["make_latest"], "false")
        self.assertEqual(api.release["body"], "Custom release notes")
        latest = api.read_manifest(api.assets["latest.json"])
        self.assertEqual(latest["notes"], "Custom release notes")
        self.assertIn("v2.0.0-rc.1%2Bbuild.5/", latest["platforms"]["windows-x86_64"]["url"])
        self.assertFalse(should_make_latest("v1.9.0-rc.1", None))
        self.assertFalse(should_make_latest("v1.8.3", "v1.9.0"))
        self.assertFalse(should_make_latest("v1.8.3+rebuilt", "v1.8.3"))
        self.assertTrue(should_make_latest("v1.10.0", "v1.9.0"))
        self.assertEqual(set(bundle_files(tag, "linux")), {"appimage"})
        self.assertEqual(set(bundle_files(TAG, "linux")), {"appimage", "deb", "rpm"})

    def test_failed_upload_leaves_one_draft_and_rerun_does_not_downgrade_latest(self):
        api = FakeGitHub(latest="v1.9.0")
        artifact_fixtures(self.artifacts)
        upload = api.upload

        def interrupt(release, name, file):
            if name == APPIMAGE:
                raise ValueError("interrupted upload")
            return upload(release, name, file)

        with patch.object(api, "upload", side_effect=interrupt), self.assertRaisesRegex(ValueError, "interrupted upload"):
            self.publish(api)
        self.assertTrue(api.release["draft"])
        self.assertNotIn("latest.json", api.assets)
        self.publish(api)
        self.assertEqual(sum(write[0] == "POST" for write in api.writes), 1)
        self.assertEqual(api.writes[-1], ("PATCH", "/releases/1", {"draft": False, "make_latest": "false"}))

    def seed_repair(self, draft=False, prerelease=False):
        api = FakeGitHub(state=(draft, prerelease))
        api.add(APPIMAGE, b"old appimage")
        api.add(APPIMAGE + ".sig", b"old signature")
        entry = {"signature": "old signature", "url": asset_url(REPO, TAG, APPIMAGE)}
        old = {"version": TAG[1:], "pub_date": DATE, "notes": "old notes",
               "platforms": {"linux-x86_64": entry, "linux-x86_64-appimage": entry}}
        api.add("latest.json", json.dumps(old).encode())
        artifact_fixtures(self.artifacts, selected="macos")
        return api, old

    def test_manual_repair_preserves_release_state_assets_and_other_entries(self):
        api, old = self.seed_repair(draft=True, prerelease=True)
        self.publish(api, selection="macos", repair=True)
        self.assertTrue(api.release["draft"])
        self.assertTrue(api.release["prerelease"])
        self.assertEqual(api.assets[APPIMAGE]["content"], b"old appimage")
        latest = api.read_manifest(api.assets["latest.json"])
        self.assertEqual(latest["notes"], old["notes"])
        for key, entry in old["platforms"].items():
            self.assertEqual(latest["platforms"][key], entry)
        self.assertIn("darwin-x86_64", latest["platforms"])
        self.assertIn(APPIMAGE, api.assets["SHA256SUMS.txt"]["content"].decode())
        api.writes.clear()
        self.publish(api, selection="macos", repair=True)
        self.assertEqual(api.writes, [])

    def test_conflicting_public_asset_rejected_before_any_write(self):
        api, _ = self.seed_repair()
        conflict = "Mini.MQTT.Client_1.8.3_universal.dmg"
        api.add(conflict, b"existing public installer")
        with self.assertRaisesRegex(ValueError, "Published asset .* different content"):
            self.publish(api, selection="macos", repair=True)
        self.assertEqual(api.writes, [])
        self.assertEqual(api.assets[conflict]["content"], b"existing public installer")
        api.release["draft"] = True
        self.publish(api, selection="macos", repair=True)
        self.assertEqual(api.assets[conflict]["content"], conflict.encode())

    def test_repair_can_resume_interrupted_manifest_replacement(self):
        api, old = self.seed_repair()
        rename = api.rename

        def interrupt(asset, name):
            if name == "latest.json":
                raise ValueError("interrupted")
            return rename(asset, name)

        with patch.object(api, "rename", side_effect=interrupt), self.assertRaisesRegex(ValueError, "interrupted"):
            self.publish(api, selection="macos", repair=True)
        self.assertIn("latest.json.previous", api.assets)
        self.publish(api, selection="macos", repair=True)
        latest = api.read_manifest(api.assets["latest.json"])
        self.assertEqual(latest["platforms"]["linux-x86_64"], old["platforms"]["linux-x86_64"])
        self.assertFalse(any(name.endswith((".previous", ".pending")) for name in api.assets))

    def test_public_repair_keeps_valid_existing_signature_despite_new_timestamp(self):
        api, _ = self.seed_repair()
        archive = "Mini.MQTT.Client_1.8.3_universal.app.tar.gz"
        old_signature = f"sig:{archive}|signed-at-1"
        api.add(archive, archive.encode())
        api.add(archive + ".sig", old_signature.encode())
        self.publish(api, selection="macos", repair=True)
        self.assertEqual(api.assets[archive + ".sig"]["content"], old_signature.encode())
        for target in ("darwin-aarch64", "darwin-x86_64"):
            entry = api.read_manifest(api.assets["latest.json"])["platforms"][target]
            self.assertEqual(entry["signature"], old_signature)
        self.assertIn("Mini.MQTT.Client_1.8.3_universal.dmg", api.assets)

    def test_public_repair_rejects_invalid_existing_signature(self):
        api, _ = self.seed_repair()
        archive = "Mini.MQTT.Client_1.8.3_universal.app.tar.gz"
        api.add(archive, archive.encode())
        api.add(archive + ".sig", b"invalid signature")
        with self.assertRaisesRegex(ValueError, "Signature does not match"):
            self.publish(api, selection="macos", repair=True)
        self.assertEqual(api.writes, [])

    def test_missing_public_manifest_is_restored_even_when_rebuild_conflicts(self):
        api, old = self.seed_repair()
        api.rename(api.assets["latest.json"], "latest.json.previous")
        archive = "Mini.MQTT.Client_1.8.3_universal.app.tar.gz"
        api.add(archive, b"non-reproducible previous build")
        with self.assertRaisesRegex(ValueError, "Published asset .* different content"):
            self.publish(api, selection="macos", repair=True)
        self.assertEqual(api.read_manifest(api.assets["latest.json"]), old)
        self.assertEqual(api.assets[archive]["content"], b"non-reproducible previous build")

    def test_repair_rejects_moved_tag_and_unsafe_release_links(self):
        api, old = self.seed_repair()
        with self.assertRaisesRegex(ValueError, "Tag changed"):
            self.publish(api, selection="macos", repair=True, commit="b" * 40)
        self.assertEqual(api.writes, [])
        entry = old["platforms"]["linux-x86_64"]
        for url in (asset_url(REPO, "v1.8.2", APPIMAGE), asset_url("someone/fork", TAG, APPIMAGE),
                    asset_url(REPO, TAG, "../" + APPIMAGE), asset_url(REPO, TAG, APPIMAGE) + "?x=1"):
            entry["url"] = url
            with self.subTest(url=url), self.assertRaisesRegex(ValueError, "Invalid existing updater entry"):
                merge_manifest(old, {}, REPO, TAG, {APPIMAGE}, "", DATE)

    @unittest.skipUnless(shutil.which("minisign"), "minisign unavailable")
    def test_minisign_checks_artifact_bytes(self):
        public, secret = self.root / "key.pub", self.root / "key.sec"
        artifact, signature = self.root / "bundle", self.root / "bundle.minisig"
        subprocess.run(["minisign", "-G", "-W", "-p", public, "-s", secret],
                       check=True, capture_output=True)
        artifact.write_bytes(b"binary payload")
        subprocess.run(["minisign", "-S", "-s", secret, "-m", artifact, "-x", signature],
                       check=True, capture_output=True)
        payload = base64.b64encode(signature.read_bytes())
        key = public.read_text().splitlines()[1]
        verify_signature(key, artifact, payload)
        artifact.write_bytes(b"wrong payload")
        with self.assertRaises(subprocess.CalledProcessError):
            verify_signature(key, artifact, payload)


if __name__ == "__main__":
    unittest.main()
