import json
import os
import pathlib
import subprocess
import sys
import time


if len(sys.argv) != 2:
    raise SystemExit("usage: linger-probe.py <pid-result>")

result_path = pathlib.Path(sys.argv[1])
child = subprocess.Popen(
    [sys.executable, "-c", "import time; time.sleep(300)"],
    close_fds=True,
)
result_path.write_text(
    json.dumps({"parentPid": os.getpid(), "childPid": child.pid}),
    encoding="utf-8",
)
time.sleep(300)
