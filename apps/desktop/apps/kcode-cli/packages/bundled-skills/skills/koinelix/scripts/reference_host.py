"""Reference POSIX host adapter using the public authenticated payment-v1 socket.

A trusted launcher supplies bootstrap data through a private inherited socket;
no wallet database, KoinCode files, environment secrets or private keys are read.
"""
import json
import os
from pathlib import Path
import re
import socket
import stat

from image_config import validated_url
from wallet_client import ClientError, MAX_FRAME_BYTES, WalletClient

BOOTSTRAP_TIMEOUT_SECONDS = 10
PAYMENT_TIMEOUT_SECONDS = 45 * 60
PAYMENT_METHODS = {"capabilities", "prepare_payment", "authorize_payment", "get_payment",
                   "reconcile_payment", "cancel_payment"}


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate bootstrap key")
        result[key] = value
    return result


def private_directory(value):
    if not isinstance(value, str) or not Path(value).is_absolute():
        raise ClientError("REFERENCE_HOST_CONTEXT_INVALID")
    path = Path(value)
    if path.is_symlink():
        raise ClientError("REFERENCE_HOST_CONTEXT_INVALID")
    info = path.stat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ClientError("REFERENCE_HOST_CONTEXT_INVALID")
    return str(path)


class ReferenceHost:
    def __init__(self, fd=4):
        self.wallet = None
        self.digests = {}
        if os.name == "nt" or not hasattr(socket, "AF_UNIX"):
            raise ClientError("REFERENCE_HOST_PLATFORM_UNSUPPORTED")
        if type(fd) is not int or fd < 3:
            raise ClientError("REFERENCE_HOST_BOOTSTRAP_INVALID")
        try:
            with socket.socket(fileno=fd) as channel:
                channel.settimeout(BOOTSTRAP_TIMEOUT_SECONDS)
                with channel.makefile("rb") as stream:
                    line = stream.readline(MAX_FRAME_BYTES + 1)
            if not line.endswith(b"\n") or len(line) > MAX_FRAME_BYTES:
                raise ValueError("Invalid bootstrap frame")
            value = json.loads(line, object_pairs_hook=unique_object)
            required = {"version", "socketPath", "clientId", "token", "context"}
            if (not isinstance(value, dict) or set(value) - (required | {"credential"})
                    or not required <= set(value) or type(value["version"]) is not int or value["version"] != 1):
                raise ValueError("Invalid bootstrap")
            context = value["context"]
            if (not isinstance(context, dict) or set(context) != {"taskId", "stateDirectory", "outputDirectory"}
                    or not isinstance(context["taskId"], str) or not re.fullmatch(r"[a-f0-9]{64}", context["taskId"])):
                raise ValueError("Invalid task")
            self.context = {"protocolVersion": 1, "taskId": context["taskId"],
                            "stateDirectory": private_directory(context["stateDirectory"]),
                            "outputDirectory": private_directory(context["outputDirectory"])}
            if self.context["stateDirectory"] == self.context["outputDirectory"]:
                raise ValueError("State and output must differ")
            self.credential = value.get("credential")
            if self.credential is not None:
                c = self.credential
                if (not isinstance(c, dict) or set(c) != {"url", "secret", "credentialTag"}
                        or not isinstance(c["secret"], str) or not c["secret"] or len(c["secret"]) > 8192
                        or any(ord(ch) < 32 or ord(ch) == 127 for ch in c["secret"])
                        or not isinstance(c["credentialTag"], str) or not re.fullmatch(r"[a-f0-9]{64}", c["credentialTag"])):
                    raise ValueError("Invalid credential")
                validated_url(c["url"])
            path = value["socketPath"]
            if not isinstance(path, str) or not Path(path).is_absolute():
                raise ValueError("Invalid socket")
            info = Path(path).lstat()
            if not stat.S_ISSOCK(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
                raise ValueError("Unprotected socket")
            for key in ("clientId", "token"):
                if not isinstance(value[key], str) or not value[key] or len(value[key]) > 8192:
                    raise ValueError("Invalid authentication")
            connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            try:
                connection.settimeout(BOOTSTRAP_TIMEOUT_SECONDS)
                connection.connect(path)
                connection.setblocking(True)
                self.wallet = WalletClient(connection.detach())
                self.wallet.socket.settimeout(BOOTSTRAP_TIMEOUT_SECONDS)
                auth = {"clientId": value["clientId"], "token": value["token"], "protocol": "payment-v1"}
                self.wallet.pipe.write(json.dumps(auth, separators=(",", ":")).encode() + b"\n")
                self.wallet.pipe.flush()
                reply = self.wallet.pipe.readline(MAX_FRAME_BYTES + 1)
                authenticated = json.loads(reply)
                if (len(reply) > MAX_FRAME_BYTES or not reply.endswith(b"\n")
                        or not isinstance(authenticated, dict) or set(authenticated) != {"authenticated"}
                        or authenticated["authenticated"] is not True):
                    raise ClientError("REFERENCE_HOST_AUTHENTICATION_FAILED")
                self.wallet.socket.settimeout(PAYMENT_TIMEOUT_SECONDS)
            finally:
                connection.close()
        except (OSError, ValueError, TypeError, KeyError, UnicodeError):
            self.close()
            raise ClientError("REFERENCE_HOST_BOOTSTRAP_INVALID") from None
        except ClientError:
            self.close()
            raise

    def call(self, method, **params):
        if method == "context" and not params:
            return dict(self.context)
        if method == "credential.read":
            if not self.credential or params != {"url": self.credential["url"]}:
                raise ClientError("SERVICE_CREDENTIAL_NOT_FOUND")
            return {key: self.credential[key] for key in ("secret", "credentialTag")}
        if method not in PAYMENT_METHODS:
            raise ClientError("WALLET_CLIENT_METHOD_UNSUPPORTED")
        if method == "authorize_payment":
            payment_id = params.get("paymentId")
            if payment_id not in self.digests or set(params) != {"paymentId"}:
                raise ClientError("PAYMENT_CONTEXT_REQUIRED")
            params = {**params, "requestDigest": self.digests[payment_id]}
        value = self.wallet.call(method, **params)
        if method == "prepare_payment":
            self.digests[value["paymentId"]] = params["payment"]["requestDigest"]
        return value

    def close(self):
        self.credential = None
        if self.wallet:
            self.wallet.close()
            self.wallet = None
        self.digests.clear()
