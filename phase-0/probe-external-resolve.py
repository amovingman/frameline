"""Read-only macOS probe for an external Resolve scripting connection.

Prints only connection status and Resolve version. It never opens, saves, or
changes a project. Run while Resolve is fully open:
    python3 phase-0/probe-external-resolve.py
"""

import json
import os
import subprocess
import sys
from pathlib import Path


MODULE = Path("/Library/Application Support/Blackmagic Design/DaVinci Resolve/Developer/Scripting/Modules/DaVinciResolveScript.py")
LIBRARY = "/Applications/DaVinci Resolve/DaVinci Resolve.app/Contents/Libraries/Fusion/fusionscript.so"


def probe():
    result = {"schemaVersion": 1, "readOnly": True, "connected": False,
              "resolveVersion": None, "reason": "external-connection-unavailable"}
    try:
        if not MODULE.is_file():
            return {**result, "reason": "scripting-module-unavailable"}
        environment = os.environ.copy()
        environment.setdefault("RESOLVE_SCRIPT_LIB", LIBRARY)
        environment["PYTHONPATH"] = str(MODULE.parent) + os.pathsep + environment.get("PYTHONPATH", "")
        child = subprocess.run([sys.executable, "-c",
            "import json, DaVinciResolveScript as bmd; "
            "r=bmd.scriptapp('Resolve'); "
            "print(json.dumps({'connected': r is not None, "
            "'resolveVersion': r.GetVersionString() if r else None}))"],
            env=environment, capture_output=True, text=True, timeout=8, check=False)
        if child.returncode != 0:
            return {**result, "reason": "external-probe-failed"}
        payload = json.loads(child.stdout)
        if payload.get("connected") is True and isinstance(payload.get("resolveVersion"), str):
            return {**result, "connected": True, "resolveVersion": payload["resolveVersion"], "reason": "connected"}
        return result
    except subprocess.TimeoutExpired:
        return {**result, "reason": "external-connection-timeout"}
    except Exception:
        return {**result, "reason": "external-probe-failed"}


if __name__ == "__main__":
    print(json.dumps(probe(), sort_keys=True))
