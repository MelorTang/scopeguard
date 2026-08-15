#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <sddl.h>
#include <bcrypt.h>

#include <algorithm>
#include <array>
#include <cstddef>
#include <cstdint>
#include <cwctype>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <iterator>
#include <stdexcept>
#include <string>
#include <vector>

namespace {

constexpr DWORD kMaximumRequestBytes = 64 * 1024;
constexpr DWORD kMaximumResponseBytes = 256 * 1024;
constexpr DWORD kWorkerTimeoutMilliseconds = 180000;

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

class LocalMemory {
public:
    explicit LocalMemory(HLOCAL value = nullptr) : value_(value) {}
    LocalMemory(const LocalMemory&) = delete;
    LocalMemory& operator=(const LocalMemory&) = delete;
    ~LocalMemory() {
        if (value_) {
            LocalFree(value_);
        }
    }
    HLOCAL get() const { return value_; }

private:
    HLOCAL value_ = nullptr;
};

struct Config {
    std::wstring service_name;
    std::wstring pipe_name;
    std::wstring broker_sid;
    std::wstring broker_image;
    std::wstring broker_sha256;
    std::wstring pwsh;
    std::wstring pwsh_sha256;
    std::wstring worker;
    std::wstring worker_sha256;
    std::wstring provisioner;
    std::wstring provisioner_sha256;
    std::wstring lifecycle;
    std::wstring lifecycle_sha256;
    std::wstring runtime_pack;
    std::wstring runtime_pack_sha256;
    std::wstring registry;
    std::wstring registry_sha256;
    std::wstring state_root;
    std::wstring request_root;
    std::wstring launcher;
    std::wstring launcher_sha256;
    std::wstring diagnostics;
};

Config g_config;
SERVICE_STATUS_HANDLE g_status_handle = nullptr;
SERVICE_STATUS g_status{};
Handle g_stop_event;

[[noreturn]] void ThrowLastError(const char* operation) {
    const DWORD error = GetLastError();
    throw std::runtime_error(
        std::string(operation) + " failed with Win32 error " +
        std::to_string(error));
}

void CheckNt(NTSTATUS status, const char* operation) {
    if (status < 0) {
        throw std::runtime_error(
            std::string(operation) + " failed with NTSTATUS " +
            std::to_string(status));
    }
}

std::wstring ToLower(std::wstring value) {
    std::transform(value.begin(), value.end(), value.begin(), [](wchar_t ch) {
        return static_cast<wchar_t>(towlower(ch));
    });
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

std::wstring RequireOption(
    const std::vector<std::wstring>& args,
    const std::wstring& name) {
    for (std::size_t index = 0; index + 1 < args.size(); ++index) {
        if (args[index] == name) {
            if (args[index + 1].empty()) {
                throw std::runtime_error("service option value must not be empty");
            }
            return args[index + 1];
        }
    }
    throw std::runtime_error("missing required service option");
}

void ValidatePipeName(const std::wstring& name) {
    if (name.empty() || name.size() > 128) {
        throw std::runtime_error("pipe name length is invalid");
    }
    for (const wchar_t ch : name) {
        if (!iswalnum(ch) && ch != L'.' && ch != L'-' && ch != L'_') {
            throw std::runtime_error("pipe name contains an invalid character");
        }
    }
}

Config ParseServiceConfig(const std::vector<std::wstring>& args) {
    Config config{
        RequireOption(args, L"--service-name"),
        RequireOption(args, L"--pipe"),
        RequireOption(args, L"--broker-sid"),
        RequireOption(args, L"--broker-image"),
        ToLower(RequireOption(args, L"--broker-sha256")),
        RequireOption(args, L"--pwsh"),
        ToLower(RequireOption(args, L"--pwsh-sha256")),
        RequireOption(args, L"--worker"),
        ToLower(RequireOption(args, L"--worker-sha256")),
        RequireOption(args, L"--provisioner"),
        ToLower(RequireOption(args, L"--provisioner-sha256")),
        RequireOption(args, L"--lifecycle"),
        ToLower(RequireOption(args, L"--lifecycle-sha256")),
        RequireOption(args, L"--runtime-pack"),
        ToLower(RequireOption(args, L"--runtime-pack-sha256")),
        RequireOption(args, L"--registry"),
        ToLower(RequireOption(args, L"--registry-sha256")),
        RequireOption(args, L"--state-root"),
        RequireOption(args, L"--request-root"),
        RequireOption(args, L"--launcher"),
        ToLower(RequireOption(args, L"--launcher-sha256")),
        RequireOption(args, L"--diagnostics"),
    };
    ValidatePipeName(config.pipe_name);
    return config;
}

void LogDiagnostic(const std::string& message) {
    std::ofstream output(
        std::filesystem::path(g_config.diagnostics),
        std::ios::out | std::ios::app);
    if (output) {
        output << GetTickCount64() << ' ' << message << '\n';
    }
}

std::wstring CanonicalFilePath(const std::wstring& path) {
    Handle file(CreateFileW(
        path.c_str(),
        FILE_READ_ATTRIBUTES,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
        nullptr,
        OPEN_EXISTING,
        FILE_ATTRIBUTE_NORMAL,
        nullptr));
    if (!file) {
        ThrowLastError("CreateFileW(canonical path)");
    }
    const DWORD length = GetFinalPathNameByHandleW(
        file.get(), nullptr, 0, FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
    if (length == 0) {
        ThrowLastError("GetFinalPathNameByHandleW(size)");
    }
    std::wstring result(length, L'\0');
    const DWORD written = GetFinalPathNameByHandleW(
        file.get(), result.data(), length, FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
    if (written == 0 || written >= length) {
        ThrowLastError("GetFinalPathNameByHandleW(path)");
    }
    result.resize(written);
    if (result.starts_with(L"\\\\?\\")) {
        result.erase(0, 4);
    }
    return ToLower(result);
}

std::wstring Sha256File(const std::wstring& path) {
    BCRYPT_ALG_HANDLE algorithm = nullptr;
    BCRYPT_HASH_HANDLE hash = nullptr;
    CheckNt(BCryptOpenAlgorithmProvider(
        &algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0),
        "BCryptOpenAlgorithmProvider");
    try {
        DWORD object_length = 0;
        DWORD hash_length = 0;
        DWORD copied = 0;
        CheckNt(BCryptGetProperty(
            algorithm,
            BCRYPT_OBJECT_LENGTH,
            reinterpret_cast<PUCHAR>(&object_length),
            sizeof(object_length),
            &copied,
            0), "BCryptGetProperty(object length)");
        CheckNt(BCryptGetProperty(
            algorithm,
            BCRYPT_HASH_LENGTH,
            reinterpret_cast<PUCHAR>(&hash_length),
            sizeof(hash_length),
            &copied,
            0), "BCryptGetProperty(hash length)");
        std::vector<UCHAR> object(object_length);
        std::vector<UCHAR> digest(hash_length);
        CheckNt(BCryptCreateHash(
            algorithm,
            &hash,
            object.data(),
            static_cast<ULONG>(object.size()),
            nullptr,
            0,
            0), "BCryptCreateHash");
        Handle file(CreateFileW(
            path.c_str(),
            GENERIC_READ,
            FILE_SHARE_READ,
            nullptr,
            OPEN_EXISTING,
            FILE_FLAG_SEQUENTIAL_SCAN,
            nullptr));
        if (!file) {
            ThrowLastError("CreateFileW(hash)");
        }
        std::array<UCHAR, 64 * 1024> buffer{};
        while (true) {
            DWORD read = 0;
            if (!ReadFile(
                    file.get(),
                    buffer.data(),
                    static_cast<DWORD>(buffer.size()),
                    &read,
                    nullptr)) {
                ThrowLastError("ReadFile(hash)");
            }
            if (read == 0) {
                break;
            }
            CheckNt(BCryptHashData(hash, buffer.data(), read, 0), "BCryptHashData");
        }
        CheckNt(BCryptFinishHash(
            hash, digest.data(), static_cast<ULONG>(digest.size()), 0),
            "BCryptFinishHash");
        static constexpr wchar_t hexadecimal[] = L"0123456789abcdef";
        std::wstring result;
        result.reserve(digest.size() * 2);
        for (const UCHAR byte : digest) {
            result.push_back(hexadecimal[byte >> 4]);
            result.push_back(hexadecimal[byte & 0x0f]);
        }
        BCryptDestroyHash(hash);
        hash = nullptr;
        BCryptCloseAlgorithmProvider(algorithm, 0);
        algorithm = nullptr;
        return result;
    } catch (...) {
        if (hash) {
            BCryptDestroyHash(hash);
        }
        if (algorithm) {
            BCryptCloseAlgorithmProvider(algorithm, 0);
        }
        throw;
    }
}

void VerifyFile(
    const std::wstring& path,
    const std::wstring& expected_sha256,
    const char* context) {
    if (expected_sha256.size() != 64 || Sha256File(path) != expected_sha256) {
        throw std::runtime_error(std::string(context) + " SHA-256 mismatch");
    }
}

void VerifyPinnedFiles() {
    VerifyFile(g_config.pwsh, g_config.pwsh_sha256, "PowerShell");
    VerifyFile(g_config.worker, g_config.worker_sha256, "Worker");
    VerifyFile(g_config.provisioner, g_config.provisioner_sha256, "Provisioner");
    VerifyFile(g_config.lifecycle, g_config.lifecycle_sha256, "Lifecycle helper");
    VerifyFile(g_config.runtime_pack, g_config.runtime_pack_sha256, "Runtime helper");
    VerifyFile(g_config.registry, g_config.registry_sha256, "Registry");
    VerifyFile(g_config.launcher, g_config.launcher_sha256, "Launcher");
}

void WriteExact(HANDLE handle, const void* data, DWORD size) {
    const auto* bytes = static_cast<const std::byte*>(data);
    DWORD total = 0;
    while (total < size) {
        DWORD written = 0;
        if (!WriteFile(handle, bytes + total, size - total, &written, nullptr)) {
            ThrowLastError("WriteFile(pipe)");
        }
        if (written == 0) {
            throw std::runtime_error("pipe write returned zero bytes");
        }
        total += written;
    }
}

void ReadExact(HANDLE handle, void* data, DWORD size) {
    auto* bytes = static_cast<std::byte*>(data);
    DWORD total = 0;
    while (total < size) {
        DWORD read = 0;
        if (!ReadFile(handle, bytes + total, size - total, &read, nullptr)) {
            ThrowLastError("ReadFile(pipe)");
        }
        if (read == 0) {
            throw std::runtime_error("pipe closed before the frame completed");
        }
        total += read;
    }
}

std::vector<std::byte> ReadFrame(HANDLE pipe, DWORD maximum_size) {
    std::uint32_t size = 0;
    ReadExact(pipe, &size, sizeof(size));
    if (size == 0 || size > maximum_size) {
        throw std::runtime_error("pipe frame size is invalid");
    }
    std::vector<std::byte> result(size);
    ReadExact(pipe, result.data(), size);
    return result;
}

void WriteFrame(HANDLE pipe, const std::vector<std::byte>& data) {
    if (data.empty() || data.size() > kMaximumResponseBytes) {
        throw std::runtime_error("response frame size is invalid");
    }
    const auto size = static_cast<std::uint32_t>(data.size());
    WriteExact(pipe, &size, sizeof(size));
    WriteExact(pipe, data.data(), size);
}

std::wstring ClientSid(HANDLE pipe) {
    if (!ImpersonateNamedPipeClient(pipe)) {
        ThrowLastError("ImpersonateNamedPipeClient");
    }
    try {
        Handle token;
        HANDLE raw_token = nullptr;
        if (!OpenThreadToken(GetCurrentThread(), TOKEN_QUERY, TRUE, &raw_token)) {
            ThrowLastError("OpenThreadToken(client)");
        }
        token.reset(raw_token);
        DWORD size = 0;
        GetTokenInformation(token.get(), TokenUser, nullptr, 0, &size);
        if (GetLastError() != ERROR_INSUFFICIENT_BUFFER) {
            ThrowLastError("GetTokenInformation(client size)");
        }
        std::vector<std::byte> buffer(size);
        if (!GetTokenInformation(
                token.get(), TokenUser, buffer.data(), size, &size)) {
            ThrowLastError("GetTokenInformation(client)");
        }
        const auto* user = reinterpret_cast<const TOKEN_USER*>(buffer.data());
        LPWSTR sid_text = nullptr;
        if (!ConvertSidToStringSidW(user->User.Sid, &sid_text)) {
            ThrowLastError("ConvertSidToStringSidW(client)");
        }
        LocalMemory sid_memory(sid_text);
        const std::wstring result(sid_text);
        if (!RevertToSelf()) {
            ThrowLastError("RevertToSelf(client)");
        }
        return result;
    } catch (...) {
        RevertToSelf();
        throw;
    }
}

void VerifyClient(HANDLE pipe) {
    const std::wstring sid = ClientSid(pipe);
    if (_wcsicmp(sid.c_str(), g_config.broker_sid.c_str()) != 0) {
        throw std::runtime_error("client SID is not authorized");
    }
    ULONG process_id = 0;
    if (!GetNamedPipeClientProcessId(pipe, &process_id) || process_id == 0) {
        ThrowLastError("GetNamedPipeClientProcessId");
    }
    Handle process(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, process_id));
    if (!process) {
        ThrowLastError("OpenProcess(client)");
    }
    DWORD capacity = 32768;
    std::wstring image(capacity, L'\0');
    if (!QueryFullProcessImageNameW(process.get(), 0, image.data(), &capacity)) {
        ThrowLastError("QueryFullProcessImageNameW(client)");
    }
    image.resize(capacity);
    if (CanonicalFilePath(image) != CanonicalFilePath(g_config.broker_image)) {
        throw std::runtime_error("client image path is not authorized");
    }
    VerifyFile(image, g_config.broker_sha256, "Broker client");
}

std::wstring RandomFileStem() {
    std::array<UCHAR, 16> bytes{};
    CheckNt(BCryptGenRandom(
        nullptr,
        bytes.data(),
        static_cast<ULONG>(bytes.size()),
        BCRYPT_USE_SYSTEM_PREFERRED_RNG), "BCryptGenRandom");
    static constexpr wchar_t hexadecimal[] = L"0123456789abcdef";
    std::wstring result;
    result.reserve(bytes.size() * 2);
    for (const UCHAR byte : bytes) {
        result.push_back(hexadecimal[byte >> 4]);
        result.push_back(hexadecimal[byte & 0x0f]);
    }
    return result;
}

void WriteProtectedRequest(
    const std::wstring& path,
    const std::vector<std::byte>& content) {
    Handle file(CreateFileW(
        path.c_str(),
        GENERIC_WRITE,
        0,
        nullptr,
        CREATE_NEW,
        FILE_ATTRIBUTE_NORMAL,
        nullptr));
    if (!file) {
        ThrowLastError("CreateFileW(request)");
    }
    WriteExact(file.get(), content.data(), static_cast<DWORD>(content.size()));
    if (!FlushFileBuffers(file.get())) {
        ThrowLastError("FlushFileBuffers(request)");
    }
}

std::vector<std::byte> ReadBoundedFile(const std::wstring& path, DWORD maximum_size) {
    std::ifstream input(std::filesystem::path(path), std::ios::binary);
    if (!input) {
        throw std::runtime_error("worker response file is missing");
    }
    std::vector<char> chars(
        (std::istreambuf_iterator<char>(input)),
        std::istreambuf_iterator<char>());
    if (chars.empty() || chars.size() > maximum_size) {
        throw std::runtime_error("worker response file size is invalid");
    }
    std::vector<std::byte> result(chars.size());
    std::transform(chars.begin(), chars.end(), result.begin(), [](char ch) {
        return static_cast<std::byte>(static_cast<unsigned char>(ch));
    });
    return result;
}

Handle CreateWorkerJob() {
    Handle job(CreateJobObjectW(nullptr, nullptr));
    if (!job) {
        ThrowLastError("CreateJobObjectW(worker)");
    }
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
    limits.BasicLimitInformation.LimitFlags =
        JOB_OBJECT_LIMIT_ACTIVE_PROCESS |
        JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION |
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    limits.BasicLimitInformation.ActiveProcessLimit = 16;
    if (!SetInformationJobObject(
            job.get(),
            JobObjectExtendedLimitInformation,
            &limits,
            sizeof(limits))) {
        ThrowLastError("SetInformationJobObject(worker)");
    }
    return job;
}

std::vector<std::byte> RunWorker(
    const std::vector<std::byte>* request,
    bool recovery) {
    VerifyPinnedFiles();
    const std::wstring stem = RandomFileStem();
    const std::filesystem::path root(g_config.request_root);
    const std::wstring request_path = (root / (stem + L".request.json")).wstring();
    const std::wstring response_path = (root / (stem + L".response.json")).wstring();
    const std::wstring log_path = (root / (stem + L".worker.log")).wstring();
    if (request) {
        WriteProtectedRequest(request_path, *request);
    }

    SECURITY_ATTRIBUTES inheritable{};
    inheritable.nLength = sizeof(inheritable);
    inheritable.bInheritHandle = TRUE;
    Handle log(CreateFileW(
        log_path.c_str(),
        GENERIC_WRITE,
        FILE_SHARE_READ,
        &inheritable,
        CREATE_NEW,
        FILE_ATTRIBUTE_NORMAL,
        nullptr));
    if (!log) {
        if (request) {
            DeleteFileW(request_path.c_str());
        }
        ThrowLastError("CreateFileW(worker log)");
    }
    Handle null_input(CreateFileW(
        L"NUL",
        GENERIC_READ,
        FILE_SHARE_READ | FILE_SHARE_WRITE,
        &inheritable,
        OPEN_EXISTING,
        FILE_ATTRIBUTE_NORMAL,
        nullptr));
    if (!null_input) {
        ThrowLastError("CreateFileW(NUL)");
    }

    std::vector<std::wstring> command{
        g_config.pwsh,
        L"-NoLogo",
        L"-NoProfile",
        L"-NonInteractive",
        L"-File",
        g_config.worker,
        L"-Operation",
        recovery ? L"recover" : L"request",
        L"-ProvisionerScript",
        g_config.provisioner,
        L"-RegistryPath",
        g_config.registry,
        L"-StateRoot",
        g_config.state_root,
        L"-Launcher",
        g_config.launcher,
        L"-ResponsePath",
        response_path,
    };
    if (request) {
        command.push_back(L"-RequestPath");
        command.push_back(request_path);
    }
    std::wstring command_line = BuildCommandLine(command);
    STARTUPINFOW startup{};
    startup.cb = sizeof(startup);
    startup.dwFlags = STARTF_USESTDHANDLES;
    startup.hStdInput = null_input.get();
    startup.hStdOutput = log.get();
    startup.hStdError = log.get();
    PROCESS_INFORMATION process_info{};
    Handle job = CreateWorkerJob();
    if (!CreateProcessW(
            g_config.pwsh.c_str(),
            command_line.data(),
            nullptr,
            nullptr,
            TRUE,
            CREATE_SUSPENDED | CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT,
            nullptr,
            nullptr,
            &startup,
            &process_info)) {
        ThrowLastError("CreateProcessW(worker)");
    }
    Handle process(process_info.hProcess);
    Handle thread(process_info.hThread);
    if (!AssignProcessToJobObject(job.get(), process.get())) {
        TerminateProcess(process.get(), 126);
        ThrowLastError("AssignProcessToJobObject(worker)");
    }
    if (ResumeThread(thread.get()) == static_cast<DWORD>(-1)) {
        TerminateJobObject(job.get(), 126);
        ThrowLastError("ResumeThread(worker)");
    }
    const HANDLE waits[] = {process.get(), g_stop_event.get()};
    const DWORD wait = WaitForMultipleObjects(2, waits, FALSE, kWorkerTimeoutMilliseconds);
    if (wait != WAIT_OBJECT_0) {
        TerminateJobObject(job.get(), wait == WAIT_OBJECT_0 + 1 ? 125 : 124);
        WaitForSingleObject(process.get(), 5000);
        throw std::runtime_error(
            wait == WAIT_OBJECT_0 + 1 ? "service is stopping" : "worker timed out");
    }
    DWORD exit_code = 126;
    if (!GetExitCodeProcess(process.get(), &exit_code)) {
        ThrowLastError("GetExitCodeProcess(worker)");
    }
    log.reset();
    std::vector<std::byte> response;
    try {
        response = ReadBoundedFile(response_path, kMaximumResponseBytes);
        if (exit_code != 0) {
            throw std::runtime_error("worker rejected startup recovery");
        }
    } catch (...) {
        if (request) {
            DeleteFileW(request_path.c_str());
        }
        DeleteFileW(response_path.c_str());
        throw;
    }
    if (request) {
        DeleteFileW(request_path.c_str());
    }
    DeleteFileW(response_path.c_str());
    DeleteFileW(log_path.c_str());
    return response;
}

void SetServiceState(DWORD state, DWORD error = NO_ERROR) {
    g_status.dwServiceType = SERVICE_WIN32_OWN_PROCESS;
    g_status.dwCurrentState = state;
    g_status.dwControlsAccepted =
        state == SERVICE_RUNNING ? SERVICE_ACCEPT_STOP | SERVICE_ACCEPT_SHUTDOWN : 0;
    g_status.dwWin32ExitCode = error;
    g_status.dwWaitHint = state == SERVICE_START_PENDING ? 120000 : 0;
    g_status.dwCheckPoint = state == SERVICE_START_PENDING ? 1 : 0;
    if (g_status_handle && !SetServiceStatus(g_status_handle, &g_status)) {
        ThrowLastError("SetServiceStatus");
    }
}

DWORD WINAPI ServiceControlHandler(
    DWORD control,
    DWORD,
    LPVOID,
    LPVOID) {
    if (control == SERVICE_CONTROL_STOP || control == SERVICE_CONTROL_SHUTDOWN) {
        SetServiceState(SERVICE_STOP_PENDING);
        if (g_stop_event) {
            SetEvent(g_stop_event.get());
        }
    }
    return NO_ERROR;
}

Handle CreatePipeInstance() {
    const std::wstring sddl =
        L"D:P(A;;GA;;;SY)(A;;GRGW;;;" + g_config.broker_sid + L")";
    PSECURITY_DESCRIPTOR raw_descriptor = nullptr;
    if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl.c_str(),
            SDDL_REVISION_1,
            &raw_descriptor,
            nullptr)) {
        ThrowLastError("ConvertStringSecurityDescriptorToSecurityDescriptorW(pipe)");
    }
    LocalMemory descriptor(raw_descriptor);
    SECURITY_ATTRIBUTES security{};
    security.nLength = sizeof(security);
    security.lpSecurityDescriptor = raw_descriptor;
    const std::wstring path = L"\\\\.\\pipe\\" + g_config.pipe_name;
    Handle pipe(CreateNamedPipeW(
        path.c_str(),
        PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED,
        PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
        1,
        kMaximumResponseBytes,
        kMaximumRequestBytes,
        0,
        &security));
    if (!pipe) {
        ThrowLastError("CreateNamedPipeW");
    }
    return pipe;
}

bool WaitForClient(HANDLE pipe) {
    Handle connected(CreateEventW(nullptr, TRUE, FALSE, nullptr));
    if (!connected) {
        ThrowLastError("CreateEventW(pipe connect)");
    }
    OVERLAPPED overlapped{};
    overlapped.hEvent = connected.get();
    bool already_connected = false;
    if (!ConnectNamedPipe(pipe, &overlapped)) {
        const DWORD error = GetLastError();
        if (error == ERROR_PIPE_CONNECTED) {
            already_connected = true;
            SetEvent(connected.get());
        } else if (error != ERROR_IO_PENDING) {
            ThrowLastError("ConnectNamedPipe");
        }
    }
    const HANDLE waits[] = {g_stop_event.get(), connected.get()};
    const DWORD wait = WaitForMultipleObjects(2, waits, FALSE, INFINITE);
    if (wait == WAIT_OBJECT_0) {
        CancelIoEx(pipe, &overlapped);
        return false;
    }
    if (wait != WAIT_OBJECT_0 + 1) {
        ThrowLastError("WaitForMultipleObjects(pipe)");
    }
    if (!already_connected) {
        DWORD transferred = 0;
        if (!GetOverlappedResult(pipe, &overlapped, &transferred, FALSE)) {
            ThrowLastError("GetOverlappedResult(pipe)");
        }
    }
    return true;
}

void Serve() {
    const std::vector<std::byte> empty_request;
    (void)RunWorker(nullptr, true);
    LogDiagnostic("startup recovery completed");
    SetServiceState(SERVICE_RUNNING);
    while (WaitForSingleObject(g_stop_event.get(), 0) == WAIT_TIMEOUT) {
        Handle pipe = CreatePipeInstance();
        if (!WaitForClient(pipe.get())) {
            break;
        }
        try {
            const auto request = ReadFrame(pipe.get(), kMaximumRequestBytes);
            LogDiagnostic("bounded request frame read");
            VerifyClient(pipe.get());
            LogDiagnostic("client identity verified");
            const auto response = RunWorker(&request, false);
            LogDiagnostic("request worker completed");
            WriteFrame(pipe.get(), response);
            FlushFileBuffers(pipe.get());
        } catch (const std::exception& error) {
            LogDiagnostic(std::string("request failed: ") + error.what());
            // Authentication and framing failures are intentionally silent.
        }
        DisconnectNamedPipe(pipe.get());
    }
}

void WINAPI ServiceMain(DWORD, LPWSTR*) {
    g_status_handle = RegisterServiceCtrlHandlerExW(
        g_config.service_name.c_str(), ServiceControlHandler, nullptr);
    if (!g_status_handle) {
        return;
    }
    try {
        SetServiceState(SERVICE_START_PENDING);
        g_stop_event.reset(CreateEventW(nullptr, TRUE, FALSE, nullptr));
        if (!g_stop_event) {
            ThrowLastError("CreateEventW(stop)");
        }
        VerifyPinnedFiles();
        LogDiagnostic("pinned startup files verified");
        Serve();
        SetServiceState(SERVICE_STOPPED);
    } catch (const std::exception& error) {
        LogDiagnostic(std::string("service startup failed: ") + error.what());
        SetServiceState(SERVICE_STOPPED, ERROR_SERVICE_SPECIFIC_ERROR);
    }
}

int RunService() {
    SERVICE_TABLE_ENTRYW table[] = {
        {g_config.service_name.data(), ServiceMain},
        {nullptr, nullptr},
    };
    if (!StartServiceCtrlDispatcherW(table)) {
        ThrowLastError("StartServiceCtrlDispatcherW");
    }
    return 0;
}

int RunClient(const std::wstring& pipe_name) {
    ValidatePipeName(pipe_name);
    std::vector<char> input_chars(
        (std::istreambuf_iterator<char>(std::cin)),
        std::istreambuf_iterator<char>());
    if (input_chars.empty() || input_chars.size() > kMaximumRequestBytes) {
        throw std::runtime_error("client request size is invalid");
    }
    std::vector<std::byte> request(input_chars.size());
    std::transform(input_chars.begin(), input_chars.end(), request.begin(), [](char ch) {
        return static_cast<std::byte>(static_cast<unsigned char>(ch));
    });
    const std::wstring path = L"\\\\.\\pipe\\" + pipe_name;
    if (!WaitNamedPipeW(path.c_str(), 15000)) {
        ThrowLastError("WaitNamedPipeW(client)");
    }
    Handle pipe(CreateFileW(
        path.c_str(),
        GENERIC_READ | GENERIC_WRITE,
        0,
        nullptr,
        OPEN_EXISTING,
        FILE_ATTRIBUTE_NORMAL,
        nullptr));
    if (!pipe) {
        ThrowLastError("CreateFileW(client pipe)");
    }
    WriteFrame(pipe.get(), request);
    const auto response = ReadFrame(pipe.get(), kMaximumResponseBytes);
    std::cout.write(
        reinterpret_cast<const char*>(response.data()),
        static_cast<std::streamsize>(response.size()));
    std::cout << '\n';
    return 0;
}

}  // namespace

int wmain(int argc, wchar_t** argv) {
    try {
        const std::vector<std::wstring> args(argv + 1, argv + argc);
        if (!args.empty() && args[0] == L"--service") {
            g_config = ParseServiceConfig(args);
            return RunService();
        }
        if (args.size() == 3 && args[0] == L"--client" && args[1] == L"--pipe") {
            return RunClient(args[2]);
        }
        throw std::runtime_error(
            "usage: scopeguard-provisioner-service --service <options> | "
            "--client --pipe <name>");
    } catch (const std::exception& error) {
        std::cerr << "scopeguard-provisioner-service: " << error.what() << '\n';
        return 126;
    }
}
