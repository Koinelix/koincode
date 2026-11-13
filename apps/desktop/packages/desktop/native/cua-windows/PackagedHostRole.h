#pragma once
#include <windows.h>
#include <string>

namespace fcode::cua {
void requirePackagedHostRole(HANDLE process, std::wstring const& image);
}
