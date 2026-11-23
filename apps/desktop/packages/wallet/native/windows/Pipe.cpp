#include "Native.h"
#include <condition_variable>
#include <map>
#include <thread>

namespace koincode::wallet {
namespace {
struct Connection {
  Handle pipe;
  Handle process;
  Handle stopped{CreateEventW(nullptr, TRUE, FALSE, nullptr)};
  uint32_t id = 0;
  std::atomic<bool> closed = false;
  std::mutex output;
  void close() {
    if (closed.exchange(true))
      return;
    SetEvent(stopped.value);
    CancelIoEx(pipe.value, nullptr);
    DisconnectNamedPipe(pipe.value);
  }
};
struct Broker {
  Handle stop{CreateEventW(nullptr, TRUE, FALSE, nullptr)};
  // Retain an owned instance until its successor exists, even after peer close.
  Handle anchor;
  std::mutex output, guard;
  std::condition_variable drained;
  std::map<uint32_t, std::shared_ptr<Connection>> connections;
  size_t workers = 0;
  std::atomic<bool> failed = false;
  void emit(BYTE kind, uint32_t id, const BYTE *bytes = nullptr, size_t count = 0) {
    require(count + 5 <= FrameLimit);
    std::lock_guard lock(output);
    uint32_t length = static_cast<uint32_t>(count + 5);
    BYTE header[9];
    memcpy(header, &length, 4);
    header[4] = kind;
    memcpy(header + 5, &id, 4);
    writeAll(GetStdHandle(STD_OUTPUT_HANDLE), header, sizeof(header));
    if (count)
      writeAll(GetStdHandle(STD_OUTPUT_HANDLE), bytes, count);
  }
};
bool transfer(Broker &broker, Connection &connection, BYTE *bytes, DWORD count, bool writing,
              DWORD &actual) {
  Handle event(CreateEventW(nullptr, TRUE, FALSE, nullptr));
  require(static_cast<bool>(event));
  OVERLAPPED overlap{};
  overlap.hEvent = event.value;
  if (connection.closed)
    return false;
  BOOL ok = writing ? WriteFile(connection.pipe.value, bytes, count, &actual, &overlap)
                    : ReadFile(connection.pipe.value, bytes, count, &actual, &overlap);
  if (!ok && GetLastError() != ERROR_IO_PENDING)
    return false;
  if (!ok) {
    HANDLE waits[] = {event.value, broker.stop.value, connection.stopped.value,
                      connection.process.value};
    DWORD result = WaitForMultipleObjects(4, waits, FALSE, writing ? 11000 : INFINITE);
    if (result != WAIT_OBJECT_0) {
      CancelIoEx(connection.pipe.value, &overlap);
      GetOverlappedResult(connection.pipe.value, &overlap, &actual, TRUE);
      return false;
    }
    if (!GetOverlappedResult(connection.pipe.value, &overlap, &actual, FALSE))
      return false;
  }
  return !connection.closed && WaitForSingleObject(connection.process.value, 0) == WAIT_TIMEOUT;
}
void reader(std::shared_ptr<Broker> broker, std::shared_ptr<Connection> connection) {
  try {
    BYTE bytes[65536];
    WipeBuffer wipe{bytes, sizeof(bytes)};
    DWORD count = 0;
    while (!connection->closed &&
           transfer(*broker, *connection, bytes, sizeof(bytes), false, count) && count)
      broker->emit(2, connection->id, bytes, count);
    SecureZeroMemory(bytes, sizeof(bytes));
  } catch (...) {
    broker->failed = true;
    SetEvent(broker->stop.value);
  }
  connection->close();
  try {
    broker->emit(3, connection->id);
  } catch (...) {
    broker->failed = true;
    SetEvent(broker->stop.value);
  }
  {
    std::lock_guard lock(broker->guard);
    broker->connections.erase(connection->id);
    broker->workers--;
  }
  broker->drained.notify_all();
}
void acceptConnection(const std::shared_ptr<Broker> &broker, Handle pipe, uint32_t id,
                      bool server) {
  auto report = peer(pipe.value, server);
  ULONG pid = 0;
  require((server ? GetNamedPipeClientProcessId(pipe.value, &pid)
                  : GetNamedPipeServerProcessId(pipe.value, &pid)) != FALSE);
  auto connection = std::make_shared<Connection>();
  require(static_cast<bool>(connection->stopped));
  connection->pipe = std::move(pipe);
  connection->id = id;
  connection->process =
      Handle(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, pid));
  require(static_cast<bool>(connection->process));
  require(peer(connection->pipe.value, server) == report &&
          WaitForSingleObject(connection->process.value, 0) == WAIT_TIMEOUT);
  {
    std::lock_guard lock(broker->guard);
    require(broker->connections.size() < 32);
    broker->connections[id] = connection;
    broker->workers++;
  }
  try {
    broker->emit(1, id, reinterpret_cast<const BYTE *>(report.data()), report.size());
    std::thread(reader, broker, connection).detach();
  } catch (...) {
    connection->close();
    std::lock_guard lock(broker->guard);
    broker->connections.erase(id);
    broker->workers--;
    throw;
  }
}
void acceptLoop(const std::shared_ptr<Broker> &broker, const std::wstring &path) {
  try {
    Security security;
    bool first = true;
    uint32_t next = 1;
    while (WaitForSingleObject(broker->stop.value, 0) == WAIT_TIMEOUT) {
      {
        std::unique_lock lock(broker->guard);
        broker->drained.wait(lock, [&] {
          return broker->connections.size() < 32 ||
                 WaitForSingleObject(broker->stop.value, 0) != WAIT_TIMEOUT;
        });
      }
      if (WaitForSingleObject(broker->stop.value, 0) != WAIT_TIMEOUT)
        break;
      Handle pipe(CreateNamedPipeW(
          path.c_str(),
          PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED | (first ? FILE_FLAG_FIRST_PIPE_INSTANCE : 0),
          PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS, 33, 65536,
          65536, 5000, &security.attributes));
      require(static_cast<bool>(pipe));
      HANDLE retained = INVALID_HANDLE_VALUE;
      require(DuplicateHandle(GetCurrentProcess(), pipe.value, GetCurrentProcess(), &retained, 0,
                              FALSE, DUPLICATE_SAME_ACCESS) != FALSE);
      broker->anchor = Handle(retained);
      if (first) {
        broker->emit(5, 0);
        first = false;
      }
      Handle event(CreateEventW(nullptr, TRUE, FALSE, nullptr));
      OVERLAPPED overlap{};
      overlap.hEvent = event.value;
      DWORD unused = 0;
      BOOL connected = ConnectNamedPipe(pipe.value, &overlap);
      DWORD error = connected ? ERROR_SUCCESS : GetLastError();
      if (error == ERROR_IO_PENDING) {
        HANDLE waits[] = {event.value, broker->stop.value};
        DWORD result = WaitForMultipleObjects(2, waits, FALSE, INFINITE);
        if (result != WAIT_OBJECT_0) {
          CancelIoEx(pipe.value, &overlap);
          GetOverlappedResult(pipe.value, &overlap, &unused, TRUE);
          break;
        }
        require(GetOverlappedResult(pipe.value, &overlap, &unused, FALSE) != FALSE);
      } else
        require(connected || error == ERROR_PIPE_CONNECTED);
      try {
        require(next != 0);
        acceptConnection(broker, std::move(pipe), next++, true);
      } catch (const Failure &) { /* Rejected peers acquire no application session. */
        DisconnectNamedPipe(broker->anchor.value);
      }
    }
  } catch (...) {
    broker->failed = true;
    try {
      broker->emit(6, 0);
    } catch (...) {
    }
    SetEvent(broker->stop.value);
  }
}
} // namespace
int pipeBroker(const std::vector<std::wstring> &args) {
  require(args.size() == 2, 78);
  const auto &path = args[1];
  const auto prefix = L"\\\\.\\pipe\\KoinCodeWallet-v1-";
  require(path.starts_with(prefix) && path.size() < 240 &&
              path.find_first_not_of(
                  L"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.\\:") ==
                  std::wstring::npos,
          78);
  auto broker = std::make_shared<Broker>();
  require(static_cast<bool>(broker->stop));
  std::thread acceptor;
  if (args[0] == L"server")
    acceptor = std::thread(acceptLoop, broker, path);
  else {
    require(WaitNamedPipeW(path.c_str(), 5000) != FALSE);
    Handle pipe(CreateFileW(path.c_str(), GENERIC_READ | GENERIC_WRITE, 0, nullptr, OPEN_EXISTING,
                            FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION,
                            nullptr));
    require(static_cast<bool>(pipe));
    acceptConnection(broker, std::move(pipe), 1, false);
  }
  try {
    for (;;) {
      uint32_t length = 0;
      DWORD headerBytes = 0;
      const BOOL header =
          ReadFile(GetStdHandle(STD_INPUT_HANDLE), &length, 4, &headerBytes, nullptr);
      if ((!header && GetLastError() == ERROR_BROKEN_PIPE && headerBytes == 0) ||
          (header && headerBytes == 0))
        break;
      require(header != FALSE && headerBytes > 0 && headerBytes <= 4);
      require(headerBytes == 4 ||
              readExact(GetStdHandle(STD_INPUT_HANDLE),
                        reinterpret_cast<BYTE *>(&length) + headerBytes, 4 - headerBytes));
      require(length >= 5 && length <= FrameLimit);
      SensitiveBytes frame{std::vector<BYTE>(length)};
      require(readExact(GetStdHandle(STD_INPUT_HANDLE), frame.data(), length));
      BYTE kind = frame[0];
      uint32_t id = 0;
      memcpy(&id, frame.data() + 1, 4);
      if (kind == 4) {
        require(id == 0 && length == 5);
        break;
      }
      std::shared_ptr<Connection> connection;
      {
        std::lock_guard lock(broker->guard);
        auto found = broker->connections.find(id);
        if (found != broker->connections.end())
          connection = found->second;
      }
      if (!connection)
        continue;
      if (kind == 3) {
        require(length == 5);
        connection->close();
      } else {
        require(kind == 2);
        std::lock_guard lock(connection->output);
        size_t offset = 5;
        while (offset < frame.size()) {
          DWORD count = 0;
          auto size =
              static_cast<DWORD>(std::min(frame.size() - offset, static_cast<size_t>(65536)));
          if (!transfer(*broker, *connection, frame.data() + offset, size, true, count) || !count) {
            connection->close();
            break;
          }
          offset += count;
        }
      }
      SecureZeroMemory(frame.data(), frame.size());
    }
  } catch (...) {
    broker->failed = true;
  }
  SetEvent(broker->stop.value);
  {
    std::lock_guard lock(broker->guard);
    for (auto &item : broker->connections)
      item.second->close();
  }
  broker->drained.notify_all();
  if (acceptor.joinable())
    acceptor.join();
  std::unique_lock lock(broker->guard);
  require(broker->drained.wait_for(lock, std::chrono::seconds(15),
                                   [&] { return broker->workers == 0; }));
  return broker->failed ? 70 : 0;
}
} // namespace koincode::wallet
