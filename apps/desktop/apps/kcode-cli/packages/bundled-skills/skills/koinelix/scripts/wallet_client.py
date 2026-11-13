"""Language-neutral local wallet protocol over a caller-private inherited pipe."""
import json
import socket

MAX_FRAME_BYTES = 128 * 1024


class ClientError(Exception):
    def __init__(self, code):
        super().__init__(code)
        self.code = code


class WalletClient:
    def __init__(self, fd=3):
        self.socket = socket.socket(fileno=fd)
        self.pipe = self.socket.makefile("rwb")
        self.sequence = 0

    def call(self, method, **params):
        self.sequence += 1
        frame = json.dumps({"version": 1, "id": self.sequence, "method": method, "params": params},
                           separators=(",", ":")).encode("utf-8")
        if len(frame) > MAX_FRAME_BYTES:
            raise ClientError("WALLET_CLIENT_FRAME_TOO_LARGE")
        self.pipe.write(frame + b"\n")
        self.pipe.flush()
        line = self.pipe.readline(MAX_FRAME_BYTES + 1)
        if not line.endswith(b"\n") or len(line) > MAX_FRAME_BYTES:
            raise ClientError("WALLET_CLIENT_CONNECTION_LOST")
        try:
            reply = json.loads(line)
        except (ValueError, UnicodeError):
            raise ClientError("WALLET_CLIENT_PROTOCOL_INVALID") from None
        if (not isinstance(reply, dict) or type(reply.get("version")) is not int
                or reply["version"] != 1 or type(reply.get("id")) is not int
                or reply["id"] != self.sequence):
            raise ClientError("WALLET_CLIENT_PROTOCOL_INVALID")
        if reply.get("ok") is not True:
            raise ClientError(reply.get("code", "WALLET_CLIENT_FAILED"))
        return reply.get("value")

    def close(self):
        self.pipe.close()
        self.socket.close()
