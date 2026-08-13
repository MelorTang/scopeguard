import json
import os
import pathlib
import sys


if len(sys.argv) != 4:
    raise SystemExit("usage: python-probe.py <workspace> <outside> <result>")

workspace = pathlib.Path(sys.argv[1])
outside = pathlib.Path(sys.argv[2])
result_path = pathlib.Path(sys.argv[3])
allowed_path = workspace / "python-runtime-output.txt"
denied_path = outside / "python-runtime-outside.txt"

allowed_path.write_text("python-runtime-ok", encoding="utf-8")

outside_write_denied = False
outside_write_detail = "write unexpectedly succeeded"
try:
    denied_path.write_text("blocked", encoding="utf-8")
except OSError as error:
    outside_write_denied = True
    outside_write_detail = str(error)

result = {
    "kind": "python-runtime",
    "passed": (
        allowed_path.exists()
        and outside_write_denied
        and not denied_path.exists()
        and "SCOPEGUARD_SECRET_SENTINEL" not in os.environ
    ),
    "allowedWrite": allowed_path.exists(),
    "outsideWriteDenied": outside_write_denied,
    "outsideWriteDetail": outside_write_detail,
    "parentSecretInherited": "SCOPEGUARD_SECRET_SENTINEL" in os.environ,
}

result_path.write_text(json.dumps(result, indent=2), encoding="utf-8")
raise SystemExit(0 if result["passed"] else 1)
