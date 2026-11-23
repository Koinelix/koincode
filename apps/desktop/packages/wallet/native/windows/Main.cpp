#include "Native.h"
#include <fcntl.h>
#include <io.h>

int wmain(int count, wchar_t **values) {
  _setmode(_fileno(stdin), _O_BINARY);
  _setmode(_fileno(stdout), _O_BINARY);
  try {
    std::vector<std::wstring> args(values + 1, values + count);
    koincode::wallet::require(!args.empty(), 78);
    if (args[0] == L"server" || args[0] == L"client")
      return koincode::wallet::pipeBroker(args);
    return koincode::wallet::storage(args);
  } catch (const koincode::wallet::Failure &error) {
    return error.code;
  } catch (...) {
    return 70;
  }
}
