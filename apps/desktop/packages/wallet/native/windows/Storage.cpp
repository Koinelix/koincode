#include "Native.h"

namespace koincode::wallet {
static bool accountValid(const std::string &value) {
  return !value.empty() && value.size() <= 256 &&
         std::all_of(value.begin(), value.end(), [](char c) {
           return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') ||
                  c == ':' || c == '.' || c == '_' || c == '-';
         });
}
static std::vector<BYTE> readFile(const std::wstring &path, size_t limit) {
  auto checked = openChecked(path, false);
  Handle file(CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING,
                          FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
  require(static_cast<bool>(file));
  LARGE_INTEGER size{};
  require(GetFileSizeEx(file.value, &size) != FALSE && size.QuadPart > 0 &&
              static_cast<uint64_t>(size.QuadPart) <= limit,
          78);
  std::vector<BYTE> bytes(static_cast<size_t>(size.QuadPart));
  require(readExact(file.value, bytes.data(), bytes.size()));
  return bytes;
}
static void publish(const std::wstring &pending, const std::wstring &target, bool replace) {
  validateWalletPath(pending);
  validateWalletPath(target);
  require(std::filesystem::path(pending).parent_path() ==
              std::filesystem::path(target).parent_path(),
          78);
  auto parent = openChecked(std::filesystem::path(target).parent_path().wstring(), true);
  {
    auto file = openChecked(pending, false);
  }
  if (GetFileAttributesW(target.c_str()) != INVALID_FILE_ATTRIBUTES) {
    require(replace, 78);
    auto previous = openChecked(target, false);
  }
  require(MoveFileExW(pending.c_str(), target.c_str(),
                      MOVEFILE_WRITE_THROUGH | (replace ? MOVEFILE_REPLACE_EXISTING : 0)) != FALSE);
  auto file = openChecked(target, false);
}
static void writeFile(const std::wstring &target, const std::vector<BYTE> &value, bool replace) {
  Security security;
  BYTE random[16];
  require(BCryptGenRandom(nullptr, random, sizeof(random), BCRYPT_USE_SYSTEM_PREFERRED_RNG) == 0);
  std::vector<BYTE> seed(random, random + sizeof(random));
  const auto pending = target + L"." + wide(hash(seed)) + L".pending";
  Handle file(CreateFileW(pending.c_str(), GENERIC_WRITE, 0, &security.attributes, CREATE_NEW,
                          FILE_ATTRIBUTE_NORMAL | FILE_FLAG_WRITE_THROUGH, nullptr));
  require(static_cast<bool>(file));
  try {
    if (!value.empty())
      writeAll(file.value, value.data(), value.size());
    require(FlushFileBuffers(file.value) != FALSE);
    file.reset();
    publish(pending, target, replace);
  } catch (...) {
    file.reset();
    DeleteFileW(pending.c_str());
    throw;
  }
}
int storage(const std::vector<std::wstring> &args) {
  require(args.size() >= 2, 78);
  const auto operation = args[0];
  if (operation == L"stage-resources") {
    require(args.size() == 2 && args[1] == L"development", 78);
    const auto root = walletRoot() + L"\\native-resources\\user-v2";
    ensureDirectory(root);
    auto directory = openChecked(root, true);
    wchar_t module[32768];
    require(GetModuleFileNameW(nullptr, module, 32768) > 0);
    Handle input(CreateFileW(module, GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING,
                             FILE_ATTRIBUTE_NORMAL, nullptr));
    require(static_cast<bool>(input));
    LARGE_INTEGER size{};
    require(GetFileSizeEx(input.value, &size) != FALSE && size.QuadPart > 0 &&
            size.QuadPart <= 32 * 1024 * 1024);
    std::vector<BYTE> bytes(static_cast<size_t>(size.QuadPart));
    require(readExact(input.value, bytes.data(), bytes.size()));
    for (const auto name :
         {L"keychain-helper.exe", L"keychain-helper-mainnet.exe", L"keychain-helper-m4-testnet.exe",
          L"keychain-helper-general-wallet.exe"})
      writeFile(root + L"\\" + name, bytes, true);
    return 0;
  }
  if (operation == L"executable") {
    require(args.size() == 2, 78);
    auto file = openChecked(args[1], false, false);
    return 0;
  }
  if (operation == L"directory") {
    require(args.size() == 2, 78);
    ensureDirectory(args[1]);
    return 0;
  }
  if (operation == L"check") {
    require(args.size() == 3, 78);
    validateWalletPath(args[1]);
    auto file = openChecked(args[1], args[2] == L"directory");
    return 0;
  }
  if (operation == L"publish") {
    require(args.size() == 4, 78);
    publish(args[1], args[2], args[3] == L"replace");
    return 0;
  }
  if (operation == L"touch") {
    require(args.size() == 2, 78);
    validateWalletPath(args[1]);
    auto parent = openChecked(std::filesystem::path(args[1]).parent_path().wstring(), true);
    writeFile(args[1], {}, false);
    return 0;
  }
  if (operation == L"remove-file") {
    require(args.size() == 3, 78);
    validateWalletPath(args[1]);
    const auto ref = utf8(args[2]);
    require(uuid(ref), 78);
    auto parent = openChecked(args[1], true);
    const auto file = std::filesystem::path(args[1]) / args[2];
    try {
      auto held = openChecked(file.wstring(), false, true, true);
      if (!DeleteFileW(file.c_str()))
        require(GetLastError() == ERROR_FILE_NOT_FOUND);
    } catch (const Failure &error) {
      // Journal cleanup may repeat after deletion or before the file was created.
      require(error.code == 44, error.code);
    }
    return 0;
  }
  require(args.size() == (operation == L"put" ? 4u : 3u), 78);
  require(operation == L"get" || operation == L"put" || operation == L"legacy" ||
              operation == L"remove",
          78);
  const auto name = utf8(args[1]), account = utf8(args[2]);
  require(name == "testnet" || name == "m4-testnet" || name == "mainnet" || name == "general", 78);
  require(accountValid(account), 78);
  auto root = walletRoot() + L"\\windows-protected\\v1\\" + args[1];
  if (operation == L"legacy") {
    if (GetFileAttributesW(root.c_str()) == INVALID_FILE_ATTRIBUTES) {
      require(GetLastError() == ERROR_FILE_NOT_FOUND || GetLastError() == ERROR_PATH_NOT_FOUND, 78);
      const BYTE empty[] = {'[', ']'};
      writeAll(GetStdHandle(STD_OUTPUT_HANDLE), empty, 2);
      return 0;
    }
    auto directory = openChecked(root, true);
    WIN32_FIND_DATAW info{};
    HANDLE found = FindFirstFileW((root + L"\\*").c_str(), &info);
    require(found != INVALID_HANDLE_VALUE);
    bool entries = false;
    size_t count = 0;
    do {
      if (wcscmp(info.cFileName, L".") && wcscmp(info.cFileName, L"..")) {
        entries = true;
        count++;
      }
    } while (count <= 4096 && FindNextFileW(found, &info));
    FindClose(found);
    require(count <= 4096, 78);
    const std::string result = entries ? "[\"existing-protected-records\"]" : "[]";
    writeAll(GetStdHandle(STD_OUTPUT_HANDLE), reinterpret_cast<const BYTE *>(result.data()),
             result.size());
    return 0;
  }
  const auto binding = std::string("KoinCode.wallet.dpapi.v1:") + name + ":" + account;
  std::vector<BYTE> context(binding.begin(), binding.end());
  const auto target = root + L"\\" + wide(hash(context)) + L".dpapi";
  if (operation == L"get" && GetFileAttributesW(root.c_str()) == INVALID_FILE_ATTRIBUTES) {
    require(GetLastError() == ERROR_FILE_NOT_FOUND || GetLastError() == ERROR_PATH_NOT_FOUND, 78);
    return 44;
  }
  ensureDirectory(root);
  auto parent = openChecked(root, true);
  DATA_BLOB entropy{static_cast<DWORD>(context.size()), context.data()}, output{};
  if (operation == L"put") {
    require(!args[3].empty() && args[3].size() <= 7 &&
                args[3].find_first_not_of(L"0123456789") == std::wstring::npos,
            78);
    const auto expected = std::stoul(args[3]);
    require(expected > 0 && expected <= SecretLimit, 78);
    SensitiveBytes value{readInput(SecretLimit)};
    require(value.size() == expected, 78);
    SensitiveBytes plain{std::vector<BYTE>(context)};
    plain.push_back(0);
    plain.insert(plain.end(), value.begin(), value.end());
    SecureZeroMemory(value.data(), value.size());
    DATA_BLOB input{static_cast<DWORD>(plain.size()), plain.data()};
    BOOL ok = CryptProtectData(&input, L"KoinCode wallet", &entropy, nullptr, nullptr,
                               CRYPTPROTECT_UI_FORBIDDEN, &output);
    SecureZeroMemory(plain.data(), plain.size());
    require(ok != FALSE);
    std::vector<BYTE> encrypted(output.pbData, output.pbData + output.cbData);
    LocalFree(output.pbData);
    writeFile(target, encrypted, true);
    return 0;
  }
  if (operation == L"remove") {
    const auto separator = account.find(':', 2);
    require(account.starts_with("r:") && separator == 38 && uuid(account.substr(2, 36)), 78);
    const auto remainder = account.substr(39);
    const auto end = remainder.find(':');
    require(end != std::string::npos &&
                (remainder.substr(0, end) == "http-blob" ||
                 remainder.substr(0, end) == "http-quarantine") &&
                uuid(remainder.substr(end + 1)),
            78);
    if (!DeleteFileW(target.c_str()))
      require(GetLastError() == ERROR_FILE_NOT_FOUND);
    return 0;
  }
  require(operation == L"get", 78);
  auto encrypted = readFile(target, SecretLimit + 65536);
  DATA_BLOB input{static_cast<DWORD>(encrypted.size()), encrypted.data()};
  require(CryptUnprotectData(&input, nullptr, &entropy, nullptr, nullptr, CRYPTPROTECT_UI_FORBIDDEN,
                             &output) != FALSE,
          78);
  try {
    require(output.cbData > context.size() + 1 &&
                output.cbData <= context.size() + 1 + SecretLimit &&
                std::equal(context.begin(), context.end(), output.pbData) &&
                output.pbData[context.size()] == 0,
            78);
    writeAll(GetStdHandle(STD_OUTPUT_HANDLE), output.pbData + context.size() + 1,
             output.cbData - context.size() - 1);
  } catch (...) {
    SecureZeroMemory(output.pbData, output.cbData);
    LocalFree(output.pbData);
    throw;
  }
  SecureZeroMemory(output.pbData, output.cbData);
  LocalFree(output.pbData);
  return 0;
}
} // namespace koincode::wallet
