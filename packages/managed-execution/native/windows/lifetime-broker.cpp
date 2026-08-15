#define WIN32_LEAN_AND_MEAN
#include <windows.h>

#include <cstddef>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <iterator>
#include <stdexcept>
#include <string>
#include <vector>

namespace {

class Handle {
public:
    Handle() = default;
    explicit Handle(HANDLE value) : value_(value) {}
    Handle(const Handle&) = delete;
    Handle& operator=(const Handle&) = delete;
    Handle(Handle&& other) noexcept : value_(other.release()) {}
    Handle& operator=(Handle&& other) noexcept {
        if (this != &other) {
            reset(other.release());
        }
        return *this;
    }
    ~Handle() { reset(); }

    HANDLE get() const { return value_; }
    explicit operator bool() const {
        return value_ && value_ != INVALID_HANDLE_VALUE;
    }
    HANDLE release() {
        HANDLE value = value_;
        value_ = nullptr;
        return value;
    }
    void reset(HANDLE value = nullptr) {
        if (*this) {
            CloseHandle(value_);
        }
        value_ = value;
    }

private:
    HANDLE value_ = nullptr;
};

[[noreturn]] void ThrowLastError(const char* operation) {
    const DWORD error = GetLastError();
    throw std::runtime_error(
        std::string(operation) + " failed with Win32 error " +
        std::to_string(error));
}

std::wstring QuoteArgument(const std::wstring& argument) {
    if (argument.empty()) {
        return L"\"\"";
    }
    if (argument.find_first_of(L" \t\n\v\"") == std::wstring::npos) {
        return argument;
    }

    std::wstring quoted = L"\"";
    std::size_t backslashes = 0;
    for (const wchar_t ch : argument) {
        if (ch == L'\\') {
            ++backslashes;
            continue;
        }
        if (ch == L'\"') {
            quoted.append(backslashes * 2 + 1, L'\\');
            quoted.push_back(ch);
            backslashes = 0;
            continue;
        }
        quoted.append(backslashes, L'\\');
        backslashes = 0;
        quoted.push_back(ch);
    }
    quoted.append(backslashes * 2, L'\\');
    quoted.push_back(L'\"');
    return quoted;
}

std::wstring BuildCommandLine(const std::vector<std::wstring>& command) {
    std::wstring result;
    for (const auto& argument : command) {
        if (!result.empty()) {
            result.push_back(L' ');
        }
        result.append(QuoteArgument(argument));
    }
    return result;
}

Handle DuplicateStandardHandle(DWORD standard_handle, DWORD fallback_access) {
    const HANDLE source = GetStdHandle(standard_handle);
    if (source && source != INVALID_HANDLE_VALUE) {
        HANDLE duplicate = nullptr;
        if (!DuplicateHandle(
                GetCurrentProcess(),
                source,
                GetCurrentProcess(),
                &duplicate,
                0,
                TRUE,
                DUPLICATE_SAME_ACCESS)) {
            ThrowLastError("DuplicateHandle(standard handle)");
        }
        return Handle(duplicate);
    }
    SECURITY_ATTRIBUTES security{};
    security.nLength = sizeof(security);
    security.bInheritHandle = TRUE;
    Handle fallback(CreateFileW(
        L"NUL",
        fallback_access,
        FILE_SHARE_READ | FILE_SHARE_WRITE,
        &security,
        OPEN_EXISTING,
        FILE_ATTRIBUTE_NORMAL,
        nullptr));
    if (!fallback) {
        ThrowLastError("CreateFileW(NUL standard handle)");
    }
    return fallback;
}

Handle CreateLifetimeJob() {
    Handle job(CreateJobObjectW(nullptr, nullptr));
    if (!job) {
        ThrowLastError("CreateJobObjectW");
    }

    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
    limits.BasicLimitInformation.LimitFlags =
        JOB_OBJECT_LIMIT_ACTIVE_PROCESS |
        JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION |
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    limits.BasicLimitInformation.ActiveProcessLimit = 128;
    if (!SetInformationJobObject(
            job.get(),
            JobObjectExtendedLimitInformation,
            &limits,
            sizeof(limits))) {
        ThrowLastError("SetInformationJobObject");
    }
    return job;
}

void WriteReadyFile(const std::wstring& path, DWORD host_pid) {
    std::ofstream output(
        std::filesystem::path(path),
        std::ios::out | std::ios::trunc);
    if (!output) {
        throw std::runtime_error("failed to open broker ready file");
    }
    output << "hostPid=" << host_pid << '\n';
    output.flush();
    if (!output) {
        throw std::runtime_error("failed to write broker ready file");
    }
}

int RunHost(
    DWORD parent_pid,
    const std::wstring& ready_path,
    const std::vector<std::wstring>& command) {
    if (command.empty()) {
        throw std::runtime_error("host command must not be empty");
    }

    Handle parent(OpenProcess(SYNCHRONIZE, FALSE, parent_pid));
    if (!parent) {
        ThrowLastError("OpenProcess(parent)");
    }
    Handle job = CreateLifetimeJob();
    Handle standard_input = DuplicateStandardHandle(
        STD_INPUT_HANDLE, GENERIC_READ);
    Handle standard_output = DuplicateStandardHandle(
        STD_OUTPUT_HANDLE, GENERIC_WRITE);
    Handle standard_error = DuplicateStandardHandle(
        STD_ERROR_HANDLE, GENERIC_WRITE);
    std::wstring command_line = BuildCommandLine(command);
    STARTUPINFOW startup{};
    startup.cb = sizeof(startup);
    startup.dwFlags = STARTF_USESTDHANDLES;
    startup.hStdInput = standard_input.get();
    startup.hStdOutput = standard_output.get();
    startup.hStdError = standard_error.get();
    PROCESS_INFORMATION process_info{};
    if (!CreateProcessW(
            nullptr,
            command_line.data(),
            nullptr,
            nullptr,
            TRUE,
            CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT,
            nullptr,
            nullptr,
            &startup,
            &process_info)) {
        ThrowLastError("CreateProcessW(host)");
    }

    Handle process(process_info.hProcess);
    Handle thread(process_info.hThread);
    if (!AssignProcessToJobObject(job.get(), process.get())) {
        TerminateProcess(process.get(), 126);
        ThrowLastError("AssignProcessToJobObject(host)");
    }
    if (ResumeThread(thread.get()) == static_cast<DWORD>(-1)) {
        TerminateJobObject(job.get(), 126);
        ThrowLastError("ResumeThread(host)");
    }
    WriteReadyFile(ready_path, process_info.dwProcessId);

    const HANDLE wait_handles[] = {process.get(), parent.get()};
    const DWORD wait_result = WaitForMultipleObjects(
        static_cast<DWORD>(std::size(wait_handles)),
        wait_handles,
        FALSE,
        INFINITE);
    if (wait_result == WAIT_OBJECT_0 + 1) {
        if (!TerminateJobObject(job.get(), 125)) {
            ThrowLastError("TerminateJobObject(parent exit)");
        }
        WaitForSingleObject(process.get(), 5000);
        return 125;
    }
    if (wait_result != WAIT_OBJECT_0) {
        TerminateJobObject(job.get(), 126);
        ThrowLastError("WaitForMultipleObjects(host/parent)");
    }

    DWORD exit_code = 126;
    if (!GetExitCodeProcess(process.get(), &exit_code)) {
        ThrowLastError("GetExitCodeProcess(host)");
    }
    return static_cast<int>(exit_code);
}

}  // namespace

int wmain(int argc, wchar_t** argv) {
    try {
        std::vector<std::wstring> args(argv + 1, argv + argc);
        if (
            args.size() < 6 ||
            args[0] != L"--parent-pid" ||
            args[2] != L"--ready" ||
            args[4] != L"--") {
            throw std::runtime_error(
                "usage: scopeguard-lifetime-broker --parent-pid <pid> "
                "--ready <path> -- <host> [args...]");
        }
        return RunHost(
            std::stoul(args[1]),
            args[3],
            std::vector<std::wstring>(args.begin() + 5, args.end()));
    } catch (const std::exception& error) {
        std::cerr << "scopeguard-lifetime-broker: " << error.what() << '\n';
        return 126;
    }
}
