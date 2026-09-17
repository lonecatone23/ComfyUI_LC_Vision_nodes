"""
LC Vision Nodes -- install.py
------------------------------
Auto-run by ComfyUI-Manager after clone/update (same convention as other
node packs with binary dependencies). Ensures a vision-capable llama_cpp
is importable -- installs the matching wheel from JamePeng/llama-cpp-python
(the fork Qwen3VLChatHandler/Qwen25VLChatHandler actually live in, never
merged upstream -- see README.md for why a plain requirements.txt can
never resolve this on its own) if one isn't already present.

Safe to re-run on every update: does nothing if a vision-capable llama_cpp
is already importable. Never touches other dependencies except numpy/
pillow, and even then only in response to a real conflict `pip check`
itself reports after install -- never a hardcoded version pin. Snapshots
`pip freeze` before making any change.

Confirmed directly against the fork's real GitHub Releases at the time
this was written: each release is tagged
`v{version}-{cu1XX|Metal}-{win|linux|macos}-{date}` and carries one wheel
per Python tag (cp310 through cp314) for that OS. There is no separate
CPU-only wheel for win/linux -- a CUDA-enabled build still runs on CPU via
n_gpu_layers=0 at the ComfyUI node level, matching this pack's own
device: auto/cuda/cpu design (see README.md).
"""

from __future__ import annotations

import json
import platform
import re
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

REPO = "JamePeng/llama-cpp-python"
RELEASES_URL = f"https://api.github.com/repos/{REPO}/releases?per_page=30"
TAG_RE = re.compile(r"^v(?P<version>[\d.]+)-(?P<variant>cu\d+|Metal)-(?P<os>win|linux|macos)-\d+$")

# pip check's "X has requirement Y<spec>, but you have Y <ver>" phrasing
# (confirmed as the actual live format; "X requires Y<spec>, ..." also
# seen in the wild across pip versions, so both are accepted). Non-greedy
# spec capture matters: version specs routinely contain their own commas
# (e.g. "<2,>=1.20"), so we stop only at the literal ", but you have" that
# pip always appends, not the first comma we see.
_REQUIRES_RE = re.compile(
    r"^(?P<dependent>\S+) \S+ (?:requires|has requirement) (?P<pkg>numpy|pillow|Pillow)(?P<spec>.*?), but you have \S+ [\d.]+",
    re.IGNORECASE,
)

# A real ComfyUI install commonly has dozens of pre-existing, unrelated
# version conflicts from other custom node packs pulling in different
# pins -- confirmed live in testing (sam3, fish-speech, vibevoice, gradio,
# and others all showed up in one real pip check run, none related to
# llama-cpp-python). Since this installer runs with --no-deps, the only
# way our own action could be responsible for a numpy/pillow conflict is
# if llama-cpp-python's own metadata wants a version the environment
# doesn't have -- so only react when llama-cpp-python itself is the
# package pip says is unhappy, never any other dependent.
_OUR_PACKAGE_NAMES = {"llama-cpp-python", "llama_cpp_python"}


def _log(msg: str) -> None:
    print(f"[LC Vision install] {msg}")


def _already_vision_capable() -> bool:
    try:
        import llama_cpp  # noqa: F401
    except ImportError:
        return False
    try:
        from llama_cpp.llama_chat_format import Qwen3VLChatHandler  # noqa: F401

        return True
    except ImportError:
        pass
    try:
        from llama_cpp.llama_chat_format import Qwen25VLChatHandler  # noqa: F401

        return True
    except ImportError:
        return False


def _current_platform_os() -> str:
    if sys.platform == "win32":
        return "win"
    if sys.platform == "darwin":
        return "macos"
    return "linux"


def _current_platform_tag() -> str:
    if sys.platform == "win32":
        return "win_amd64"
    if sys.platform == "darwin":
        machine = platform.machine().lower()
        return "macosx_11_0_arm64" if machine in ("arm64", "aarch64") else "macosx_10_9_x86_64"
    return "linux_x86_64"


def _current_python_tag() -> str:
    return f"cp{sys.version_info.major}{sys.version_info.minor}"


def _detected_cuda_version() -> int | None:
    """Returns e.g. 128 for CUDA 12.8, or None if torch isn't importable
    or isn't a CUDA build (CPU-only torch, or no GPU present)."""
    try:
        import torch
    except ImportError:
        return None
    cuda = getattr(torch.version, "cuda", None)
    if not cuda:
        return None
    try:
        major, minor = cuda.split(".")[:2]
        return int(major) * 10 + int(minor)
    except ValueError:
        return None


def _fetch_releases() -> list[dict]:
    req = urllib.request.Request(
        RELEASES_URL,
        headers={"Accept": "application/vnd.github+json", "User-Agent": "LC-Vision-install"},
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.load(resp)


def _pick_best_asset(releases: list[dict]) -> tuple[str, str] | None:
    """Returns (download_url, asset_name) for the best-matching wheel, or
    None if nothing usable was found. Only considers releases tagged with
    the latest version present -- the releases list is newest-first, so
    the very first parseable tag fixes what "latest" means for this run."""
    os_name = _current_platform_os()
    platform_tag = _current_platform_tag()
    python_tag = _current_python_tag()

    parsed: list[tuple[str, dict]] = []
    latest_version = None
    for rel in releases:
        m = TAG_RE.match(rel.get("tag_name", ""))
        if not m:
            continue
        if latest_version is None:
            latest_version = m.group("version")
        if m.group("version") != latest_version:
            continue
        if m.group("os") != os_name:
            continue
        parsed.append((m.group("variant"), rel))

    if not parsed:
        return None

    if os_name == "macos":
        # Metal is the only GPU backend on macOS -- one release, no
        # CUDA-style variant selection needed.
        _, rel = parsed[0]
        for asset in rel.get("assets", []):
            if f"-{python_tag}-{python_tag}-" in asset["name"] and platform_tag in asset["name"]:
                return asset["browser_download_url"], asset["name"]
        return None

    # win/linux: pick the closest CUDA tag to what's actually installed.
    # Prefer an exact match; otherwise the newest build that's still <=
    # the detected version (CUDA's runtime is backward-compatible with
    # newer drivers, so an older-than-driver build is the safe direction
    # to round toward). Only fall back to something newer than detected
    # if nothing older exists at all.
    cuda_versions = sorted({int(variant[2:]) for variant, _ in parsed})
    detected = _detected_cuda_version()
    if detected is None:
        target = cuda_versions[-1]
        _log(f"No CUDA-enabled torch detected -- defaulting to the newest available build (cu{target}).")
    else:
        eligible = [v for v in cuda_versions if v <= detected]
        if eligible:
            target = max(eligible)
        else:
            target = min(cuda_versions)
            _log(
                f"Detected CUDA {detected / 10:.1f} is older than every available build -- "
                f"falling back to the oldest one (cu{target}), which may not be fully compatible."
            )

    target_variant = f"cu{target}"
    rel = next(rel for variant, rel in parsed if variant == target_variant)
    for asset in rel.get("assets", []):
        name = asset["name"]
        if f"-{python_tag}-{python_tag}-" in name and platform_tag in name:
            return asset["browser_download_url"], name
    return None


def _run_pip(args: list[str], capture: bool = True) -> subprocess.CompletedProcess:
    cmd = [sys.executable, "-m", "pip"] + args
    _log("running: " + " ".join(cmd))
    if capture:
        return subprocess.run(cmd, capture_output=True, text=True)
    # Streamed (not captured) for the actual wheel install -- it's a large
    # (~300MB) download and the user should see pip's own progress, not a
    # silent multi-minute pause.
    return subprocess.run(cmd, text=True)


def _snapshot_pip_freeze() -> None:
    result = _run_pip(["freeze"])
    if result.returncode != 0:
        return
    backup_dir = Path(__file__).parent / "install_backups"
    backup_dir.mkdir(exist_ok=True)
    backup_path = backup_dir / f"pip_freeze_{time.strftime('%Y%m%d_%H%M%S')}.txt"
    backup_path.write_text(result.stdout, encoding="utf-8")
    _log(f"Snapshotted the current environment to {backup_path} before making any changes.")


def _clean_uninstall_existing() -> None:
    """Documented upstream pitfall: a stale llama_cpp install (especially
    a non-vision build, or one from a mismatched CUDA tag) can linger and
    shadow a fresh install unless removed first."""
    _run_pip(["uninstall", "-y", "llama-cpp-python", "llama_cpp_python"])


def _install_wheel(url: str) -> bool:
    result = _run_pip(["install", "--no-deps", "--no-cache-dir", url], capture=False)
    return result.returncode == 0


def _fix_measured_conflicts() -> None:
    """Only touches numpy/pillow, only when llama-cpp-python itself is the
    package pip says is unhappy, and only with the exact requirement pip
    itself just reported -- never a hardcoded pin. See _OUR_PACKAGE_NAMES
    for why the dependent-name check matters."""
    result = _run_pip(["check"])
    if result.returncode == 0:
        _log("pip check: no conflicts.")
        return

    fixes: dict[str, str] = {}
    other_issue_count = 0
    for line in result.stdout.splitlines():
        if not line.strip():
            continue
        m = _REQUIRES_RE.search(line)
        if m and m.group("dependent").lower().replace("_", "-") in _OUR_PACKAGE_NAMES:
            pkg = m.group("pkg").lower()
            spec = m.group("spec").strip()
            if spec:
                fixes[pkg] = f"{pkg}{spec}"
        else:
            other_issue_count += 1

    if not fixes:
        if other_issue_count:
            _log(
                f"pip check reported {other_issue_count} pre-existing issue(s) unrelated to "
                "llama-cpp-python (common in a large ComfyUI install with many custom node "
                "packs) -- leaving those alone, this installer only --no-deps installs "
                "llama-cpp-python so it can't be the cause."
            )
        else:
            _log("pip check: no conflicts involving llama-cpp-python.")
        return

    for pkg, requirement in fixes.items():
        _log(f"llama-cpp-python needs a different {pkg} -- installing pip's own measured requirement: {requirement}")
        _run_pip(["install", requirement])


def main() -> int:
    if _already_vision_capable():
        _log("A vision-capable llama_cpp (Qwen3VLChatHandler or Qwen25VLChatHandler) is already installed. Nothing to do.")
        return 0

    _log("No vision-capable llama_cpp found -- installing one from JamePeng/llama-cpp-python.")
    _snapshot_pip_freeze()

    try:
        releases = _fetch_releases()
    except Exception as exc:
        _log(f"Could not reach GitHub to list releases ({exc}). See README.md to install manually.")
        return 1

    picked = _pick_best_asset(releases)
    if not picked:
        _log(
            f"No matching wheel found for {_current_python_tag()} / {_current_platform_tag()} in the "
            f"latest {REPO} release. See README.md to install manually (or compile from source with "
            "-DLLAMA_CPP_PYTHON_VISION=on)."
        )
        return 1

    url, name = picked
    _log(f"Selected wheel: {name}")

    _clean_uninstall_existing()
    if not _install_wheel(url):
        _log("pip install failed -- see the output above. See README.md to install manually.")
        return 1

    _fix_measured_conflicts()

    if _already_vision_capable():
        _log("Install verified -- Qwen3VLChatHandler/Qwen25VLChatHandler is now importable.")
        return 0

    _log("Installed the wheel, but it still doesn't expose a vision chat handler -- something's off. See README.md.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
