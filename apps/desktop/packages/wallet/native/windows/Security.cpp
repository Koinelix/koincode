#include "Native.h"
#include <aclapi.h>
#include <cwctype>

namespace koincode::wallet {
static std::vector<BYTE> tokenInformation(HANDLE token, TOKEN_INFORMATION_CLASS kind) {
  DWORD size = 0;
  GetTokenInformation(token, kind, nullptr, 0, &size);
  require(size && size < 65536);
  std::vector<BYTE> bytes(size);
  require(GetTokenInformation(token, kind, bytes.data(), size, &size) != FALSE);
  return bytes;
}
static std::wstring sidString(PSID sid) {
  LPWSTR text = nullptr;
  require(ConvertSidToStringSidW(sid, &text) != FALSE);
  std::wstring result(text);
  LocalFree(text);
  return result;
}
Security::Security() {
  HANDLE raw = nullptr;
  require(OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &raw) != FALSE);
  Handle handle(raw);
  token = tokenInformation(handle.value, TokenUser);
  sid = sidString(reinterpret_cast<TOKEN_USER *>(token.data())->User.Sid);
  auto groups = tokenInformation(handle.value, TokenGroups);
  auto info = reinterpret_cast<TOKEN_GROUPS *>(groups.data());
  for (DWORD i = 0; i < info->GroupCount; i++)
    if ((info->Groups[i].Attributes & SE_GROUP_LOGON_ID) == SE_GROUP_LOGON_ID)
      logonSid = sidString(info->Groups[i].Sid);
  require(!logonSid.empty());
  const auto sddl = L"D:P(A;OICI;FA;;;" + sid + L")(A;OICI;FA;;;SY)";
  require(ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.c_str(), SDDL_REVISION_1,
                                                               &descriptor, nullptr) != FALSE);
  attributes = {sizeof(SECURITY_ATTRIBUTES), descriptor, FALSE};
}
Security::~Security() {
  if (descriptor)
    LocalFree(descriptor);
}
std::string utf8(const std::wstring &value) {
  int count = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(),
                                  static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr);
  require(count > 0);
  std::string result(static_cast<size_t>(count), '\0');
  require(WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(),
                              static_cast<int>(value.size()), result.data(), count, nullptr,
                              nullptr) == count);
  return result;
}
std::wstring wide(const std::string &value) {
  int count = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(),
                                  static_cast<int>(value.size()), nullptr, 0);
  require(count > 0);
  std::wstring result(static_cast<size_t>(count), L'\0');
  require(MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(),
                              static_cast<int>(value.size()), result.data(), count) == count);
  return result;
}
std::wstring profileRoot() {
  PWSTR path = nullptr;
  require(SUCCEEDED(SHGetKnownFolderPath(FOLDERID_Profile, 0, nullptr, &path)));
  std::wstring result(path);
  CoTaskMemFree(path);
  return result;
}
std::wstring walletRoot() { return profileRoot() + L"\\.koincode\\wallet"; }
static std::wstring lower(std::wstring value) {
  std::transform(value.begin(), value.end(), value.begin(),
                 [](wchar_t c) { return static_cast<wchar_t>(towlower(c)); });
  return value;
}
bool uuid(const std::string &value) {
  if (value.size() != 36)
    return false;
  for (size_t i = 0; i < value.size(); i++) {
    const bool dash = i == 8 || i == 13 || i == 18 || i == 23;
    if (dash ? value[i] != '-'
             : !((value[i] >= '0' && value[i] <= '9') || (value[i] >= 'a' && value[i] <= 'f')))
      return false;
  }
  return true;
}
void validateWalletPath(const std::wstring &input) {
  const auto path = std::filesystem::path(input).lexically_normal().wstring();
  const auto root = lower(walletRoot());
  require(path == input && input.find(L':', 2) == std::wstring::npos &&
              input.find(L"\\\\") == std::wstring::npos,
          78);
  const auto normalized = lower(path);
  require(normalized == root || (normalized.starts_with(root + L"\\")), 78);
  for (const auto &part : std::filesystem::path(input)) {
    auto text = part.wstring();
    require(text.empty() || (text.back() != L'.' && text.back() != L' '), 78);
  }
}
static void checkAclPolicy(HANDLE file, bool privateRead) {
  Security security;
  PSID owner = nullptr;
  PACL acl = nullptr;
  PSECURITY_DESCRIPTOR descriptor = nullptr;
  require(GetSecurityInfo(file, SE_FILE_OBJECT,
                          OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION, &owner, nullptr,
                          &acl, nullptr, &descriptor) == ERROR_SUCCESS,
          78);
  struct Free {
    PSECURITY_DESCRIPTOR p;
    ~Free() { LocalFree(p); }
  } cleanup{descriptor};
  require(owner && acl, 78);
  if (privateRead)
    require(EqualSid(owner, reinterpret_cast<TOKEN_USER *>(security.token.data())->User.Sid) !=
                FALSE,
            78);
  BYTE system[SECURITY_MAX_SID_SIZE];
  DWORD size = sizeof(system);
  require(CreateWellKnownSid(WinLocalSystemSid, nullptr, system, &size) != FALSE);
  BYTE administrators[SECURITY_MAX_SID_SIZE];
  size = sizeof(administrators);
  require(CreateWellKnownSid(WinBuiltinAdministratorsSid, nullptr, administrators, &size) != FALSE);
  if (!privateRead)
    require(EqualSid(owner, reinterpret_cast<TOKEN_USER *>(security.token.data())->User.Sid) ||
                EqualSid(owner, system) || EqualSid(owner, administrators),
            78);
  for (DWORD i = 0; i < acl->AceCount; i++) {
    void *raw = nullptr;
    require(GetAce(acl, i, &raw) != FALSE, 78);
    const auto header = static_cast<ACE_HEADER *>(raw);
    if (header->AceFlags & INHERIT_ONLY_ACE)
      continue;
    require(header->AceType == ACCESS_ALLOWED_ACE_TYPE || header->AceType == ACCESS_DENIED_ACE_TYPE,
            78);
    if (header->AceType == ACCESS_ALLOWED_ACE_TYPE) {
      auto ace = static_cast<ACCESS_ALLOWED_ACE *>(raw);
      PSID sid = &ace->SidStart;
      const bool own =
          EqualSid(sid, reinterpret_cast<TOKEN_USER *>(security.token.data())->User.Sid) ||
          EqualSid(sid, system);
      if (privateRead)
        require(own, 78);
      else
        require(own || EqualSid(sid, administrators) ||
                    !(ace->Mask & (GENERIC_ALL | GENERIC_WRITE | DELETE | WRITE_DAC | WRITE_OWNER |
                                   FILE_WRITE_DATA | FILE_APPEND_DATA | FILE_DELETE_CHILD)),
                78);
    }
  }
}
void checkAcl(HANDLE file) { checkAclPolicy(file, true); }
Handle openChecked(const std::wstring &path, bool directory, bool privateAcl, bool deletion) {
  std::shared_ptr<std::vector<Handle>> ancestry;
  if (lower(path).starts_with(lower(walletRoot()) + L"\\")) {
    ancestry = std::make_shared<std::vector<Handle>>();
    auto parent = profileRoot();
    auto relative = std::filesystem::path(path).parent_path().lexically_relative(parent);
    for (const auto &part : relative) {
      parent += L"\\" + part.wstring();
      Handle pinned(CreateFileW(parent.c_str(), READ_CONTROL | FILE_READ_ATTRIBUTES,
                                FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING,
                                FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS,
                                nullptr));
      require(static_cast<bool>(pinned), 78);
      BY_HANDLE_FILE_INFORMATION info{};
      require(GetFileInformationByHandle(pinned.value, &info) != FALSE &&
                  !(info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) &&
                  (info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY),
              78);
      checkAclPolicy(pinned.value, lower(parent) != lower(profileRoot() + L"\\.koincode"));
      ancestry->push_back(std::move(pinned));
    }
  }
  Handle file(CreateFileW(
      path.c_str(), READ_CONTROL | FILE_READ_ATTRIBUTES,
      FILE_SHARE_READ | FILE_SHARE_WRITE | (deletion ? FILE_SHARE_DELETE : 0), nullptr,
      OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT | (directory ? FILE_FLAG_BACKUP_SEMANTICS : 0),
      nullptr));
  require(static_cast<bool>(file), GetLastError() == ERROR_FILE_NOT_FOUND ? 44 : 78);
  BY_HANDLE_FILE_INFORMATION info{};
  require(GetFileInformationByHandle(file.value, &info) != FALSE, 78);
  require(!(info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) &&
              static_cast<bool>(info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) == directory,
          78);
  if (!directory)
    require(info.nNumberOfLinks == 1, 78);
  checkAclPolicy(file.value, privateAcl);
  file.ancestry = std::move(ancestry);
  return file;
}
void ensureDirectory(const std::wstring &path) {
  validateWalletPath(path);
  Security security;
  auto parent = profileRoot();
  auto relative = std::filesystem::path(path).lexically_relative(parent);
  std::vector<Handle> held;
  held.push_back(openChecked(parent, true, false));
  for (const auto &part : relative) {
    parent += (L"\\" + part.wstring());
    if (!CreateDirectoryW(parent.c_str(), &security.attributes))
      require(GetLastError() == ERROR_ALREADY_EXISTS, 78);
    held.push_back(
        openChecked(parent, true, lower(parent) != lower(profileRoot() + L"\\.koincode")));
  }
}
std::string hash(const std::vector<BYTE> &value) {
  BCRYPT_ALG_HANDLE algorithm = nullptr;
  require(BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0) == 0);
  BYTE bytes[32];
  auto status = BCryptHash(algorithm, nullptr, 0, const_cast<BYTE *>(value.data()),
                           static_cast<ULONG>(value.size()), bytes, sizeof(bytes));
  BCryptCloseAlgorithmProvider(algorithm, 0);
  require(status == 0);
  const char *hex = "0123456789abcdef";
  std::string result;
  for (auto byte : bytes) {
    result += hex[byte >> 4];
    result += hex[byte & 15];
  }
  return result;
}
std::string peer(HANDLE pipe, bool server) {
  ULONG pid = 0;
  require((server ? GetNamedPipeClientProcessId(pipe, &pid)
                  : GetNamedPipeServerProcessId(pipe, &pid)) != FALSE);
  Handle process(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, pid));
  require(static_cast<bool>(process));
  HANDLE raw = nullptr;
  require(OpenProcessToken(process.value, TOKEN_QUERY, &raw) != FALSE);
  Handle token(raw);
  auto user = tokenInformation(token.value, TokenUser);
  Security self;
  auto sid = sidString(reinterpret_cast<TOKEN_USER *>(user.data())->User.Sid);
  require(sid == self.sid, 77);
  auto groups = tokenInformation(token.value, TokenGroups);
  auto groupInfo = reinterpret_cast<TOKEN_GROUPS *>(groups.data());
  bool sameLogon = false;
  for (DWORD i = 0; i < groupInfo->GroupCount; i++)
    if ((groupInfo->Groups[i].Attributes & SE_GROUP_LOGON_ID) == SE_GROUP_LOGON_ID &&
        sidString(groupInfo->Groups[i].Sid) == self.logonSid)
      sameLogon = true;
  require(sameLogon, 77);
  FILETIME created{}, exit{}, kernel{}, userTime{};
  require(GetProcessTimes(process.value, &created, &exit, &kernel, &userTime) != FALSE);
  if (!server) {
    wchar_t own[32768], remote[32768];
    DWORD count = 32768;
    require(GetModuleFileNameW(nullptr, own, 32768) > 0 &&
            QueryFullProcessImageNameW(process.value, 0, remote, &count) != FALSE);
    require(lower(own) == lower(std::wstring(remote, count)), 77);
  }
  const auto stamp = (static_cast<uint64_t>(created.dwHighDateTime) << 32) | created.dwLowDateTime;
  require(WaitForSingleObject(process.value, 0) == WAIT_TIMEOUT);
  return "{\"platform\":\"win32\",\"pid\":" + std::to_string(pid) + ",\"sid\":\"" + utf8(sid) +
         "\",\"started\":\"" + std::to_string(stamp) + "\"}";
}
void writeAll(HANDLE file, const BYTE *data, size_t length) {
  while (length) {
    DWORD size = 0;
    require(WriteFile(file, data, static_cast<DWORD>(std::min(length, static_cast<size_t>(65536))),
                      &size, nullptr) != FALSE &&
            size);
    data += size;
    length -= size;
  }
}
bool readExact(HANDLE file, BYTE *data, size_t length) {
  while (length) {
    DWORD size = 0;
    if (!ReadFile(file, data, static_cast<DWORD>(std::min(length, static_cast<size_t>(65536))),
                  &size, nullptr) ||
        !size)
      return false;
    data += size;
    length -= size;
  }
  return true;
}
std::vector<BYTE> readInput(size_t limit) {
  std::vector<BYTE> result;
  BYTE bytes[65536];
  WipeBuffer wipe{bytes, sizeof(bytes)};
  DWORD count = 0;
  try {
    for (;;) {
      const BOOL ok =
          ReadFile(GetStdHandle(STD_INPUT_HANDLE), bytes, sizeof(bytes), &count, nullptr);
      if (!ok) {
        require(GetLastError() == ERROR_BROKEN_PIPE, 78);
        break;
      }
      if (!count)
        break;
      require(result.size() + count <= limit, 78);
      result.insert(result.end(), bytes, bytes + count);
    }
    return result;
  } catch (...) {
    if (!result.empty())
      SecureZeroMemory(result.data(), result.size());
    throw;
  }
}
} // namespace koincode::wallet
