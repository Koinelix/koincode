#include "PackagedHostRole.h"
#include "HostPolicy.h"
#include "NativeCrypto.h"
#include <winternl.h>
#include <algorithm>
#include <filesystem>
#include <vector>

namespace fcode::cua {
namespace {
template<class T> T remoteValue(HANDLE process, uintptr_t address) {
  require(address >= 65536, "identity_invalid");
  T value{}; SIZE_T read = 0;
  require(ReadProcessMemory(process, reinterpret_cast<void const*>(address), &value, sizeof(value), &read) &&
    read == sizeof(value), "identity_invalid");
  return value;
}
void requireMainEnvironment(HANDLE process) {
  static_assert(sizeof(void*) == 8, "Packaged Main identity requires x64");
  using Query = NTSTATUS(NTAPI*)(HANDLE, PROCESSINFOCLASS, PVOID, ULONG, PULONG);
  auto query = reinterpret_cast<Query>(GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "NtQueryInformationProcess"));
  require(query != nullptr, "identity_invalid");
  PROCESS_BASIC_INFORMATION info{}; ULONG length = 0;
  require(query(process, ProcessBasicInformation, &info, sizeof(info), &length) == 0, "identity_invalid");
  auto peb = remoteValue<PEB>(process, reinterpret_cast<uintptr_t>(info.PebBaseAddress));
  // RTL_USER_PROCESS_PARAMETERS.Environment is at 0x80 in the admitted x64 Windows 11 ABI.
  auto address = remoteValue<uintptr_t>(process, reinterpret_cast<uintptr_t>(peb.ProcessParameters) + 0x80);
  std::vector<wchar_t> environment;
  constexpr size_t limit = 128 * 1024;
  bool complete = false;
  while (environment.size() < limit && !complete) {
    MEMORY_BASIC_INFORMATION region{};
    require(VirtualQueryEx(process, reinterpret_cast<void const*>(address), &region, sizeof(region)) == sizeof(region) &&
      region.State == MEM_COMMIT && !(region.Protect & (PAGE_GUARD | PAGE_NOACCESS)), "identity_invalid");
    auto end = reinterpret_cast<uintptr_t>(region.BaseAddress) + region.RegionSize;
    require(end > address, "identity_invalid");
    auto bytes = (std::min)({ end - address, uintptr_t{4096}, (limit - environment.size()) * sizeof(wchar_t) });
    require(bytes >= sizeof(wchar_t) && bytes % sizeof(wchar_t) == 0, "identity_invalid");
    std::vector<wchar_t> block(bytes / sizeof(wchar_t)); SIZE_T read = 0;
    require(ReadProcessMemory(process, reinterpret_cast<void const*>(address), block.data(), bytes, &read) && read == bytes,
      "identity_invalid");
    for (auto value : block) {
      if (value == 0 && !environment.empty() && environment.back() == 0) { complete = true; break; }
      environment.push_back(value);
    }
    address += bytes;
  }
  require(complete, "identity_invalid");
  for (size_t start = 0; start < environment.size();) {
    std::wstring item(environment.data() + start);
    auto separator = item.find(L'=');
    if (separator != std::wstring::npos && separator > 0 && separator + 1 < item.size()) {
      auto name = item.substr(0, separator);
      require(_wcsicmp(name.c_str(), L"ELECTRON_RUN_AS_NODE") != 0 &&
        _wcsicmp(name.c_str(), L"NODE_OPTIONS") != 0 && _wcsicmp(name.c_str(), L"ELECTRON_NO_ASAR") != 0,
        "identity_invalid");
    }
    start += item.size() + 1;
  }
}
}
void requirePackagedHostRole(HANDLE process, std::wstring const& image) {
  requireMainEnvironment(process);
  auto root = std::filesystem::canonical(image).parent_path();
  auto archive = root / L"resources" / L"app.asar";
  require(std::filesystem::is_regular_file(archive) &&
    constantEqual(fileHash(archive.wstring()), FCODE_HOST_ENTRY_SHA256), "identity_invalid");
  std::wstring own(32768, L'\0');
  auto length = GetModuleFileNameW(nullptr, own.data(), static_cast<DWORD>(own.size()));
  require(length > 0 && length < own.size(), "identity_invalid"); own.resize(length);
  auto expected = root / L"resources" / L"cua-helper" / L"windows-x64" / L"fcode-cua-helper.exe";
  require(_wcsicmp(std::filesystem::canonical(own).c_str(), std::filesystem::canonical(expected).c_str()) == 0,
    "identity_invalid");
  require(WaitForSingleObject(process, 0) == WAIT_TIMEOUT, "identity_invalid");
}
}
