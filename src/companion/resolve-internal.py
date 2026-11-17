"""Read-only capture handoff for Resolve Free's internal Python console.

Load with runpy.run_path and call capture_request(resolve, REQUEST_PATH).
The request is created by Frameline's local companion protocol. This script
never changes or saves a Resolve project and never overwrites a response.
"""

import hashlib
import json
import os
from pathlib import Path
import re
import runpy
import stat as stat_module
import time


REQUEST_ID = re.compile(r"^[a-f0-9]{32}$")
SAFE_TEXT = re.compile(r"^[^\\/\x00-\x1f\x7f]*$")


def _path_free(value):
    if isinstance(value, str):
        return SAFE_TEXT.fullmatch(value) is not None and re.match(r"^[a-z]:", value, re.I) is None
    if isinstance(value, list):
        return all(_path_free(item) for item in value)
    if isinstance(value, dict):
        return all(_path_free(key) and _path_free(item) for key, item in value.items())
    return value is None or isinstance(value, (bool, int))


def capture_request(resolve, request_path):
    selected = Path(request_path)
    if not selected.is_absolute() or selected.is_symlink() or selected.parent.is_symlink():
        raise ValueError("Invalid companion request")
    if selected.parent.stat().st_mode & 0o077:
        raise ValueError("Companion directory is not private")
    fd = os.open(selected, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    try:
        info = os.fstat(fd)
        if not stat_module.S_ISREG(info.st_mode) or info.st_size < 1 or info.st_size > 4096 or info.st_mode & 0o077:
            raise ValueError("Invalid companion request")
        request_bytes = os.read(fd, info.st_size + 1)
        if len(request_bytes) != info.st_size:
            raise ValueError("Companion request changed during read")
    finally:
        os.close(fd)
    try:
        request = json.loads(request_bytes)
    except (ValueError, UnicodeError):
        raise ValueError("Invalid companion request") from None
    if not isinstance(request, dict) or set(request) != {
        "schemaVersion", "operation", "requestId", "createdAt", "expiresAt", "expectedProjectName"
    } or request["schemaVersion"] != 1 or request["operation"] != "capture" or not isinstance(request["requestId"], str) or not REQUEST_ID.fullmatch(request["requestId"]):
        raise ValueError("Invalid companion request")
    created = request["createdAt"]
    if type(created) is not int or type(request["expiresAt"]) is not int or created < 0 \
            or request["expiresAt"] != created + 300000 or time.time() * 1000 > request["expiresAt"]:
        raise ValueError("Companion request expired")
    expected = request["expectedProjectName"]
    if not isinstance(expected, str) or not expected.strip() or len(expected) > 160 or not _path_free(expected):
        raise ValueError("Invalid companion project name")
    project = resolve.GetProjectManager().GetCurrentProject()
    if project is None or project.GetName() != expected:
        raise ValueError("Open the named disposable project before capturing")
    capture = runpy.run_path(str(Path(__file__).with_name("resolve_snapshot.py")))["capture"]
    snapshot = capture(resolve)
    if snapshot.get("resolve_version") != "21.1.2.10" or not _path_free(snapshot):
        raise ValueError("Unsupported or path-bearing Resolve snapshot")
    response = {"schemaVersion": 1, "operation": "capture-result",
                "requestId": request["requestId"],
                "requestSha256": hashlib.sha256(request_bytes).hexdigest(), "snapshot": snapshot}
    destination = selected.with_name(request["requestId"] + ".response.json")
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(destination, flags, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as output:
            json.dump(response, output, separators=(",", ":"))
            output.write("\n")
            output.flush()
            os.fsync(output.fileno())
    except Exception:
        try:
            destination.unlink()
        except FileNotFoundError:
            pass
        raise
    return {"requestId": request["requestId"], "responseWritten": True,
            "readOnly": True, "safeToApply": False}
