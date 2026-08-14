import json
import os
import pathlib
import subprocess
import sys
import time


if len(sys.argv) != 4:
    raise SystemExit(
        "usage: conversation-isolation-probe.py <workspace> <peer-workspace> <result>"
    )

workspace = pathlib.Path(sys.argv[1])
peer_workspace = pathlib.Path(sys.argv[2])
result_path = pathlib.Path(sys.argv[3])

checks = {}
try:
    (workspace / "own-output.txt").write_text("own-workspace-ok", encoding="utf-8")
    checks["ownWorkspaceWrite"] = True
except OSError as error:
    checks["ownWorkspaceWrite"] = False
    checks["ownWorkspaceWriteError"] = repr(error)

try:
    (peer_workspace / "peer-secret.txt").read_text(encoding="utf-8")
    checks["peerWorkspaceReadDenied"] = False
except OSError as error:
    checks["peerWorkspaceReadDenied"] = True
    checks["peerWorkspaceReadError"] = repr(error)

try:
    (peer_workspace / "cross-write.txt").write_text("escaped", encoding="utf-8")
    checks["peerWorkspaceWriteDenied"] = False
except OSError as error:
    checks["peerWorkspaceWriteDenied"] = True
    checks["peerWorkspaceWriteError"] = repr(error)

child = subprocess.Popen(
    [sys.executable, "-c", "import time; time.sleep(300)"],
    close_fds=True,
)
result = {
    "passed": all(
        checks.get(name) is True
        for name in (
            "ownWorkspaceWrite",
            "peerWorkspaceReadDenied",
            "peerWorkspaceWriteDenied",
        )
    ),
    "parentPid": os.getpid(),
    "childPid": child.pid,
    "checks": checks,
}
result_path.write_text(json.dumps(result), encoding="utf-8")
time.sleep(300)
