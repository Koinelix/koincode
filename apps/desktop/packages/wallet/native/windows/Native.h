#pragma once
#define WIN32_LEAN_AND_MEAN
// Windows base declarations must precede the dependent SDK headers.
#include <windows.h>

#include <algorithm>
#include <atomic>
#include <bcrypt.h>
#include <cstdint>
#include <cstdio>
#include <filesystem>
#include <memory>
#include <mutex>
#include <sddl.h>
#include <shlobj.h>
#include <stdexcept>
#include <string>
#include <vector>
#include <wincrypt.h>

namespace koincode::wallet {
constexpr size_t SecretLimit = 1024 * 1024;
constexpr size_t FrameLimit = 2 * 1024 * 1024 + 5;
struct Failure : std::exception {
  int code;
  explicit Failure(int value = 70) : code(value) {}
};
struct SensitiveBytes : std::vector<BYTE> {
  explicit SensitiveBytes(std::vector<BYTE> value) : std::vector<BYTE>(std::move(value)) {}
  ~SensitiveBytes() {
    if (!empty())
      SecureZeroMemory(data(), size());
  }
};
struct WipeBuffer {
  BYTE *data;
  size_t size;
  ~WipeBuffer() { SecureZeroMemory(data, size); }
};
inline void require(bool value, int code = 70) {
  if (!value)
    throw Failure(code);
}
struct Handle {
  HANDLE value = INVALID_HANDLE_VALUE;
  std::shared_ptr<std::vector<Handle>> ancestry;
  Handle() = default;
  explicit Handle(HANDLE input) : value(input) {}
  Handle(Handle &&other) noexcept : value(other.value), ancestry(std::move(other.ancestry)) {
    other.value = INVALID_HANDLE_VALUE;
  }
  Handle &operator=(Handle &&other) noexcept {
    if (this != &other) {
      reset();
      value = other.value;
      ancestry = std::move(other.ancestry);
      other.value = INVALID_HANDLE_VALUE;
    }
    return *this;
  }
  Handle(const Handle &) = delete;
  ~Handle() { reset(); }
  void reset() {
    if (value && value != INVALID_HANDLE_VALUE)
      CloseHandle(value);
    value = INVALID_HANDLE_VALUE;
    ancestry.reset();
  }
  explicit operator bool() const { return value && value != INVALID_HANDLE_VALUE; }
};
struct Security {
  std::vector<BYTE> token;
  std::wstring sid;
  std::wstring logonSid;
  PSECURITY_DESCRIPTOR descriptor = nullptr;
  SECURITY_ATTRIBUTES attributes{};
  Security();
  ~Security();
};
std::string utf8(const std::wstring &value);
std::wstring wide(const std::string &value);
std::wstring profileRoot();
std::wstring walletRoot();
std::string hash(const std::vector<BYTE> &value);
Handle openChecked(const std::wstring &path, bool directory, bool privateAcl = true,
                   bool deletion = false);
void ensureDirectory(const std::wstring &path);
void validateWalletPath(const std::wstring &path);
void checkAcl(HANDLE file);
bool uuid(const std::string &value);
std::string peer(HANDLE pipe, bool server);
void writeAll(HANDLE file, const BYTE *data, size_t length);
bool readExact(HANDLE file, BYTE *data, size_t length);
std::vector<BYTE> readInput(size_t limit);
int storage(const std::vector<std::wstring> &args);
int pipeBroker(const std::vector<std::wstring> &args);
} // namespace koincode::wallet
