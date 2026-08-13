#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <userenv.h>
#include <sddl.h>

#include <cstddef>
#include <cstdint>
#include <cwchar>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <map>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

#pragma comment(lib, "advapi32.lib")
#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "userenv.lib")

namespace {

constexpr DWORD kProcessCreationAllApplicationPackagesOptOut = 0x1;
constexpr DWORD_PTR kProcThreadAttributeAllApplicationPackagesPolicy = 0x0002000F;
std::wstring g_diagnostics_path;

void Diagnostic(const std::string& message) {
    if (g_diagnostics_path.empty()) {
        return;
    }
    std::ofstream output(std::filesystem::path(g_diagnostics_path), std::ios::app);
    output << message << '\n';
}

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
    explicit operator bool() const { return value_ && value_ != INVALID_HANDLE_VALUE; }
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

class Sid {
public:
    Sid() = default;
    explicit Sid(PSID value) : value_(value) {}
    Sid(const Sid&) = delete;
    Sid& operator=(const Sid&) = delete;
    Sid(Sid&& other) noexcept : value_(other.release()) {}
    Sid& operator=(Sid&& other) noexcept {
        if (this != &other) {
            reset(other.release());
        }
        return *this;
    }
    ~Sid() { reset(); }

    PSID get() const { return value_; }
    explicit operator bool() const { return value_ != nullptr; }
    PSID release() {
        PSID value = value_;
        value_ = nullptr;
        return value;
    }
    void reset(PSID value = nullptr) {
        if (value_) {
            FreeSid(value_);
        }
        value_ = value;
    }

private:
    PSID value_ = nullptr;
};

[[noreturn]] void ThrowLastError(const char* operation) {
    const DWORD error = GetLastError();
    throw std::runtime_error(std::string(operation) + " failed with Win32 error " + std::to_string(error));
}

void CheckHresult(HRESULT result, const char* operation) {
    if (FAILED(result)) {
        throw std::runtime_error(std::string(operation) + " failed with HRESULT " + std::to_string(static_cast<std::uint32_t>(result)));
    }
}

Sid CreateOrOpenProfile(const std::wstring& name) {
    PSID raw_sid = nullptr;
    HRESULT result = CreateAppContainerProfile(
        name.c_str(),
        L"ScopeGuard managed execution prototype",
        L"Temporary AppContainer profile for ScopeGuard issue 14",
        nullptr,
        0,
        &raw_sid);

    if (result == HRESULT_FROM_WIN32(ERROR_ALREADY_EXISTS)) {
        result = DeriveAppContainerSidFromAppContainerName(name.c_str(), &raw_sid);
    }
    CheckHresult(result, "CreateAppContainerProfile/DeriveAppContainerSidFromAppContainerName");
    return Sid(raw_sid);
}

std::wstring SidToString(PSID sid) {
    LPWSTR raw = nullptr;
    if (!ConvertSidToStringSidW(sid, &raw)) {
        ThrowLastError("ConvertSidToStringSidW");
    }
    std::wstring value(raw);
    LocalFree(raw);
    return value;
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

struct CaseInsensitiveLess {
    bool operator()(const std::wstring& left, const std::wstring& right) const {
        return _wcsicmp(left.c_str(), right.c_str()) < 0;
    }
};

std::vector<wchar_t> BuildEnvironmentBlock(PSID package_sid) {
    std::map<std::wstring, std::wstring, CaseInsensitiveLess> environment;
    LPWCH raw_environment = GetEnvironmentStringsW();
    if (!raw_environment) {
        ThrowLastError("GetEnvironmentStringsW");
    }
    for (const wchar_t* entry = raw_environment; *entry; entry += std::wcslen(entry) + 1) {
        const std::wstring value(entry);
        const std::size_t separator = value.find(L'=', value.front() == L'=' ? 1 : 0);
        if (separator != std::wstring::npos) {
            environment[value.substr(0, separator)] = value.substr(separator + 1);
        }
    }
    FreeEnvironmentStringsW(raw_environment);

    const std::wstring sid_string = SidToString(package_sid);
    PWSTR raw_profile_path = nullptr;
    CheckHresult(
        GetAppContainerFolderPath(sid_string.c_str(), &raw_profile_path),
        "GetAppContainerFolderPath");
    const std::wstring profile_path(raw_profile_path);
    CoTaskMemFree(raw_profile_path);
    const std::wstring temp_path = profile_path + L"\\Temp";
    if (!CreateDirectoryW(temp_path.c_str(), nullptr) && GetLastError() != ERROR_ALREADY_EXISTS) {
        ThrowLastError("CreateDirectoryW(AppContainer Temp)");
    }

    environment[L"APPDATA"] = profile_path;
    environment[L"LOCALAPPDATA"] = profile_path;
    environment[L"TEMP"] = temp_path;
    environment[L"TMP"] = temp_path;
    environment[L"USERPROFILE"] = profile_path;

    std::vector<wchar_t> block;
    for (const auto& [name, value] : environment) {
        const std::wstring entry = name + L"=" + value;
        block.insert(block.end(), entry.begin(), entry.end());
        block.push_back(L'\0');
    }
    block.push_back(L'\0');
    return block;
}

void MakeStandardHandlesInheritable() {
    for (const DWORD id : {STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, STD_ERROR_HANDLE}) {
        const HANDLE handle = GetStdHandle(id);
        if (handle && handle != INVALID_HANDLE_VALUE) {
            if (!SetHandleInformation(handle, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT)) {
                ThrowLastError("SetHandleInformation");
            }
        }
    }
}

Handle CreateRestrictedJob() {
    Handle job(CreateJobObjectW(nullptr, nullptr));
    if (!job) {
        ThrowLastError("CreateJobObjectW");
    }

    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
    limits.BasicLimitInformation.LimitFlags =
        JOB_OBJECT_LIMIT_ACTIVE_PROCESS |
        JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION |
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    limits.BasicLimitInformation.ActiveProcessLimit = 32;
    if (!SetInformationJobObject(
            job.get(),
            JobObjectExtendedLimitInformation,
            &limits,
            sizeof(limits))) {
        ThrowLastError("SetInformationJobObject(JobObjectExtendedLimitInformation)");
    }

    DWORD ui_limits =
        JOB_OBJECT_UILIMIT_DESKTOP |
        JOB_OBJECT_UILIMIT_DISPLAYSETTINGS |
        JOB_OBJECT_UILIMIT_EXITWINDOWS |
        JOB_OBJECT_UILIMIT_GLOBALATOMS |
        JOB_OBJECT_UILIMIT_HANDLES |
        JOB_OBJECT_UILIMIT_READCLIPBOARD |
        JOB_OBJECT_UILIMIT_SYSTEMPARAMETERS |
        JOB_OBJECT_UILIMIT_WRITECLIPBOARD;
    if (!SetInformationJobObject(
            job.get(),
            JobObjectBasicUIRestrictions,
            &ui_limits,
            sizeof(ui_limits))) {
        ThrowLastError("SetInformationJobObject(JobObjectBasicUIRestrictions)");
    }
    return job;
}

bool ProcessHasTokenFlag(HANDLE process, TOKEN_INFORMATION_CLASS information_class) {
    HANDLE raw_token = nullptr;
    if (!OpenProcessToken(process, TOKEN_QUERY, &raw_token)) {
        ThrowLastError("OpenProcessToken(child)");
    }
    Handle token(raw_token);
    DWORD value = 0;
    DWORD returned = 0;
    if (!GetTokenInformation(
            token.get(),
            information_class,
            &value,
            sizeof(value),
            &returned)) {
        ThrowLastError("GetTokenInformation(child)");
    }
    return value != 0;
}

int RunInContainer(
    const std::wstring& profile_name,
    const std::wstring& cwd,
    DWORD timeout_seconds,
    bool lpac,
    const std::vector<std::wstring>& command) {
    if (command.empty()) {
        throw std::runtime_error("sandbox command must not be empty");
    }

    Sid package_sid = CreateOrOpenProfile(profile_name);
    const DWORD attribute_count = lpac ? 2 : 1;
    SIZE_T attribute_list_size = 0;
    InitializeProcThreadAttributeList(nullptr, attribute_count, 0, &attribute_list_size);
    if (GetLastError() != ERROR_INSUFFICIENT_BUFFER) {
        ThrowLastError("InitializeProcThreadAttributeList(size)");
    }

    std::vector<std::byte> attribute_storage(attribute_list_size);
    auto* attribute_list = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(attribute_storage.data());
    if (!InitializeProcThreadAttributeList(attribute_list, attribute_count, 0, &attribute_list_size)) {
        ThrowLastError("InitializeProcThreadAttributeList");
    }

    SECURITY_CAPABILITIES security_capabilities{};
    security_capabilities.AppContainerSid = package_sid.get();
    if (!UpdateProcThreadAttribute(
            attribute_list,
            0,
            PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES,
            &security_capabilities,
            sizeof(security_capabilities),
            nullptr,
            nullptr)) {
        DeleteProcThreadAttributeList(attribute_list);
        ThrowLastError("UpdateProcThreadAttribute(SECURITY_CAPABILITIES)");
    }

    DWORD all_application_packages_policy = kProcessCreationAllApplicationPackagesOptOut;
    if (lpac && !UpdateProcThreadAttribute(
                    attribute_list,
                    0,
                    kProcThreadAttributeAllApplicationPackagesPolicy,
                    &all_application_packages_policy,
                    sizeof(all_application_packages_policy),
                    nullptr,
                    nullptr)) {
        DeleteProcThreadAttributeList(attribute_list);
        ThrowLastError("UpdateProcThreadAttribute(ALL_APPLICATION_PACKAGES_POLICY)");
    }

    STARTUPINFOEXW startup{};
    startup.StartupInfo.cb = sizeof(startup);
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
    startup.StartupInfo.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
    startup.StartupInfo.hStdError = GetStdHandle(STD_ERROR_HANDLE);
    startup.lpAttributeList = attribute_list;
    MakeStandardHandlesInheritable();

    std::wstring command_line = BuildCommandLine(command);
    std::vector<wchar_t> environment_block = BuildEnvironmentBlock(package_sid.get());
    PROCESS_INFORMATION process_info{};
    const DWORD creation_flags =
        CREATE_SUSPENDED |
        CREATE_UNICODE_ENVIRONMENT |
        EXTENDED_STARTUPINFO_PRESENT;
    const BOOL created = CreateProcessW(
        nullptr,
        command_line.data(),
        nullptr,
        nullptr,
        TRUE,
        creation_flags,
        environment_block.data(),
        cwd.c_str(),
        &startup.StartupInfo,
        &process_info);
    DeleteProcThreadAttributeList(attribute_list);
    if (!created) {
        ThrowLastError("CreateProcessW(AppContainer)");
    }
    Diagnostic("child-created");

    Handle process(process_info.hProcess);
    Handle thread(process_info.hThread);
    if (!ProcessHasTokenFlag(process.get(), TokenIsAppContainer)) {
        TerminateProcess(process.get(), 126);
        throw std::runtime_error("created process does not have an AppContainer token");
    }
    Diagnostic("appcontainer-token-verified");
    if (lpac && !ProcessHasTokenFlag(process.get(), TokenIsLessPrivilegedAppContainer)) {
        TerminateProcess(process.get(), 126);
        throw std::runtime_error("created process does not have an LPAC token");
    }
    if (lpac) {
        Diagnostic("lpac-token-verified");
    }
    Handle job = CreateRestrictedJob();
    if (!AssignProcessToJobObject(job.get(), process.get())) {
        TerminateProcess(process.get(), 126);
        ThrowLastError("AssignProcessToJobObject");
    }
    Diagnostic("job-assigned-before-resume");
    if (ResumeThread(thread.get()) == static_cast<DWORD>(-1)) {
        TerminateJobObject(job.get(), 126);
        ThrowLastError("ResumeThread");
    }
    Diagnostic("child-resumed");

    const DWORD timeout_ms = timeout_seconds == 0 ? INFINITE : timeout_seconds * 1000;
    const DWORD wait_result = WaitForSingleObject(process.get(), timeout_ms);
    if (wait_result == WAIT_TIMEOUT) {
        TerminateJobObject(job.get(), 124);
        std::wcerr << L"sandbox command timed out after " << timeout_seconds << L" seconds\n";
        return 124;
    }
    if (wait_result != WAIT_OBJECT_0) {
        TerminateJobObject(job.get(), 126);
        ThrowLastError("WaitForSingleObject");
    }

    DWORD exit_code = 126;
    if (!GetExitCodeProcess(process.get(), &exit_code)) {
        ThrowLastError("GetExitCodeProcess");
    }
    Diagnostic("child-exit=" + std::to_string(exit_code));
    return static_cast<int>(exit_code);
}

std::wstring RequireValue(const std::vector<std::wstring>& args, std::size_t& index, std::wstring_view option) {
    static_cast<void>(option);
    if (++index >= args.size()) {
        throw std::runtime_error("missing value for option");
    }
    return args[index];
}

}  // namespace

int wmain(int argc, wchar_t** argv) {
    try {
        if (argc < 2) {
            throw std::runtime_error("usage: scopeguard-appcontainer <profile|delete|run> ...");
        }
        std::vector<std::wstring> args(argv + 1, argv + argc);

        if (args[0] == L"profile") {
            if (args.size() != 3 || args[1] != L"--name") {
                throw std::runtime_error("usage: profile --name <name>");
            }
            Sid sid = CreateOrOpenProfile(args[2]);
            std::wcout << SidToString(sid.get()) << L"\n";
            return 0;
        }

        if (args[0] == L"delete") {
            if (args.size() != 3 || args[1] != L"--name") {
                throw std::runtime_error("usage: delete --name <name>");
            }
            const HRESULT result = DeleteAppContainerProfile(args[2].c_str());
            if (FAILED(result) && result != HRESULT_FROM_WIN32(ERROR_NOT_FOUND)) {
                CheckHresult(result, "DeleteAppContainerProfile");
            }
            return 0;
        }

        if (args[0] != L"run") {
            throw std::runtime_error("unknown command");
        }

        std::wstring name;
        std::wstring cwd;
        DWORD timeout_seconds = 60;
        bool lpac = false;
        std::vector<std::wstring> command;
        for (std::size_t index = 1; index < args.size(); ++index) {
            if (args[index] == L"--name") {
                name = RequireValue(args, index, L"--name");
            } else if (args[index] == L"--cwd") {
                cwd = RequireValue(args, index, L"--cwd");
            } else if (args[index] == L"--timeout") {
                timeout_seconds = std::stoul(RequireValue(args, index, L"--timeout"));
            } else if (args[index] == L"--lpac") {
                lpac = true;
            } else if (args[index] == L"--diagnostics") {
                g_diagnostics_path = RequireValue(args, index, L"--diagnostics");
            } else if (args[index] == L"--") {
                command.assign(args.begin() + static_cast<std::ptrdiff_t>(index + 1), args.end());
                break;
            } else {
                throw std::runtime_error("unexpected run option");
            }
        }
        if (name.empty() || cwd.empty()) {
            throw std::runtime_error("run requires --name and --cwd");
        }
        return RunInContainer(name, cwd, timeout_seconds, lpac, command);
    } catch (const std::exception& error) {
        Diagnostic(std::string("error=") + error.what());
        std::cerr << "scopeguard-appcontainer: " << error.what() << "\n";
        return 126;
    }
}
