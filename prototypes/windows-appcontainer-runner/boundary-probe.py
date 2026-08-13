import ctypes
import json
import os
import pathlib
import socket
import subprocess
import sys
import winreg


if len(sys.argv) != 9:
    raise SystemExit(
        "usage: boundary-probe.py <workspace> <outside> <outside-secret> "
        "<hard-link> <credential-target> <protected-pid> <loopback-port> <result>"
    )

workspace = pathlib.Path(sys.argv[1])
outside = pathlib.Path(sys.argv[2])
outside_secret = pathlib.Path(sys.argv[3])
hard_link = pathlib.Path(sys.argv[4])
credential_target = sys.argv[5]
protected_pid = int(sys.argv[6])
loopback_port = int(sys.argv[7])
result_path = pathlib.Path(sys.argv[8])
results: list[dict[str, object]] = []

kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
advapi32 = ctypes.WinDLL("advapi32", use_last_error=True)
kernel32.GetCurrentProcess.restype = ctypes.c_void_p
kernel32.CloseHandle.argtypes = [ctypes.c_void_p]
kernel32.CloseHandle.restype = ctypes.c_int
kernel32.OpenProcess.argtypes = [ctypes.c_ulong, ctypes.c_int, ctypes.c_ulong]
kernel32.OpenProcess.restype = ctypes.c_void_p
kernel32.TerminateProcess.argtypes = [ctypes.c_void_p, ctypes.c_uint]
kernel32.TerminateProcess.restype = ctypes.c_int
advapi32.OpenProcessToken.argtypes = [
    ctypes.c_void_p,
    ctypes.c_ulong,
    ctypes.POINTER(ctypes.c_void_p),
]
advapi32.OpenProcessToken.restype = ctypes.c_int
advapi32.GetTokenInformation.argtypes = [
    ctypes.c_void_p,
    ctypes.c_int,
    ctypes.c_void_p,
    ctypes.c_ulong,
    ctypes.POINTER(ctypes.c_ulong),
]
advapi32.GetTokenInformation.restype = ctypes.c_int


def add_result(name: str, passed: bool, detail: str) -> None:
    results.append({"name": name, "passed": passed, "detail": detail})


def write_is_denied(name: str, target: pathlib.Path) -> None:
    detail = "write unexpectedly succeeded"
    try:
        target.write_text("blocked", encoding="utf-8")
    except OSError as error:
        detail = str(error)
    try:
        exists = target.exists()
    except OSError:
        exists = False
    add_result(name, not exists, detail)


token = ctypes.c_void_p()
if not advapi32.OpenProcessToken(
    kernel32.GetCurrentProcess(), 0x0008, ctypes.byref(token)
):
    raise ctypes.WinError(ctypes.get_last_error())
try:
    is_app_container = ctypes.c_ulong(0)
    returned = ctypes.c_ulong(0)
    if not advapi32.GetTokenInformation(
        token,
        29,
        ctypes.byref(is_app_container),
        ctypes.sizeof(is_app_container),
        ctypes.byref(returned),
    ):
        raise ctypes.WinError(ctypes.get_last_error())
finally:
    kernel32.CloseHandle(token)
add_result("appcontainer-token", bool(is_app_container.value), str(is_app_container.value))

workspace_input = workspace / "input.txt"
workspace_output = workspace / "boundary-output.txt"
input_value = workspace_input.read_text(encoding="utf-8-sig").strip()
workspace_output.write_text("boundary-ok", encoding="utf-8")
add_result("workspace-read", input_value == "workspace-ok", str(workspace_input))
add_result("workspace-write", workspace_output.exists(), str(workspace_output))

outside_visible = False
outside_read_detail = "read denied"
try:
    outside_visible = "scopeguard-outside-secret" in outside_secret.read_text(
        encoding="utf-8-sig"
    )
    outside_read_detail = "outside sentinel was readable"
except OSError as error:
    outside_read_detail = str(error)
add_result("outside-read-denied", not outside_visible, outside_read_detail)

write_is_denied("outside-write-denied", outside / "direct-write.txt")
write_is_denied(
    "parent-traversal-denied", workspace / ".." / "outside" / "traversal-write.txt"
)
write_is_denied(
    "junction-escape-denied", workspace / "junction-outside" / "junction-write.txt"
)
write_is_denied(
    "device-path-escape-denied",
    pathlib.Path("\\\\?\\" + str(outside) + "\\device-write.txt"),
)

hard_link_write_failed = False
hard_link_detail = "write unexpectedly succeeded"
try:
    hard_link.write_text("hardlink-overwrite", encoding="utf-8")
except OSError as error:
    hard_link_write_failed = True
    hard_link_detail = str(error)
add_result("hard-link-escape-denied", hard_link_write_failed, hard_link_detail)

registry_visible = False
registry_detail = "parent HKCU value not visible"
try:
    with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\ScopeGuardPrototype") as key:
        registry_value, _ = winreg.QueryValueEx(key, "Secret")
        registry_visible = registry_value == "scopeguard-registry-secret"
        registry_detail = "parent HKCU sentinel was visible"
except OSError as error:
    registry_detail = str(error)
add_result("parent-registry-isolated", not registry_visible, registry_detail)

credential_listing = subprocess.run(
    ["cmdkey.exe", "/list"],
    check=False,
    capture_output=True,
    text=True,
    encoding="utf-8",
    errors="replace",
).stdout
add_result(
    "credential-manager-isolated",
    credential_target not in credential_listing,
    f"target={credential_target}",
)

process_terminate = 0x0001
process_handle = kernel32.OpenProcess(process_terminate, False, protected_pid)
process_terminated = False
process_detail = "OpenProcess denied"
if process_handle:
    process_terminated = bool(kernel32.TerminateProcess(process_handle, 91))
    process_detail = (
        "termination unexpectedly succeeded"
        if process_terminated
        else f"TerminateProcess denied: {ctypes.get_last_error()}"
    )
    kernel32.CloseHandle(process_handle)
add_result("parent-process-protected", not process_terminated, process_detail)

for name, endpoint in (
    ("loopback-network-denied", ("127.0.0.1", loopback_port)),
    ("external-network-denied", ("1.1.1.1", 443)),
):
    connected = False
    detail = "connection denied"
    try:
        with socket.create_connection(endpoint, timeout=2):
            connected = True
            detail = f"connected to {endpoint[0]}:{endpoint[1]}"
    except OSError as error:
        detail = str(error)
    add_result(name, not connected, detail)

nested_outside = outside / "nested-child-write.txt"
nested_run = subprocess.run(
    [
        sys.executable,
        "-c",
        "import pathlib,sys; pathlib.Path(sys.argv[1]).write_text('nested-child')",
        str(nested_outside),
    ],
    check=False,
    capture_output=True,
    text=True,
)
try:
    nested_exists = nested_outside.exists()
except OSError:
    nested_exists = False
add_result(
    "child-process-inherits-boundary",
    not nested_exists,
    f"child_exit={nested_run.returncode}; stderr={nested_run.stderr.strip()}",
)

add_result(
    "parent-secret-env-not-inherited",
    "SCOPEGUARD_SECRET_SENTINEL" not in os.environ,
    "allowlisted environment",
)

summary = {
    "passed": all(bool(result["passed"]) for result in results),
    "results": results,
}
result_path.write_text(json.dumps(summary, indent=2), encoding="utf-8")
raise SystemExit(0 if summary["passed"] else 1)
