"""Non-secret endpoint configuration for the independent image client."""
import json
import os
from pathlib import Path
import stat
import tempfile
import urllib.parse

from wallet_client import ClientError

MAX_CONFIG_BYTES = 16 * 1024

# Default service endpoint for each fixed wallet payment network. A host that
# reports its network gets the matching endpoint, so the endpoint and the
# wallet network cannot disagree.
NETWORK_ENDPOINTS = {
    "eip155:8453": "https://api.koinelix.com/v1/images/generations",
    "eip155:84532": "http://127.0.0.1:8080/v1/images/generations",
}


def _unique_object(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError("duplicate key")
        value[key] = item
    return value


def validated_url(value):
    if (not isinstance(value, str) or len(value) > 8192
            or any(ord(char) <= 32 or ord(char) == 127 for char in value)):
        raise ClientError("IMAGE_SERVICE_URL_INVALID")
    try:
        parsed = urllib.parse.urlsplit(value)
        local = parsed.scheme == "http" and parsed.netloc == "127.0.0.1:8080"
        if parsed.username or parsed.password or "#" in value or "?" in value:
            raise ClientError("IMAGE_SERVICE_URL_INVALID")
        if not (local or (parsed.scheme == "https" and parsed.hostname and parsed.port in (None, 443))):
            raise ClientError("IMAGE_SERVICE_URL_INVALID")
        if parsed.path != "/v1/images/generations":
            raise ClientError("IMAGE_SERVICE_URL_INVALID")
    except ValueError:
        raise ClientError("IMAGE_SERVICE_URL_INVALID") from None
    return value


def config_path():
    root = os.environ.get("APPDATA" if os.name == "nt" else "HOME")
    if not root or not Path(root).is_absolute():
        raise ClientError("IMAGE_CONFIG_LOCATION_UNAVAILABLE")
    return (Path(root) / "Koinelix" / "image-client.json" if os.name == "nt"
            else Path(root) / ".config" / "koinelix" / "image-client.json")


def check_parent(path):
    # The user's home itself may be a system-managed link. Never follow a link
    # in the application-specific configuration path beneath it.
    parents = [path.parent] if os.name == "nt" else [path.parent.parent, path.parent]
    try:
        for parent in parents:
            if parent.is_symlink() or (parent.exists() and not parent.is_dir()):
                raise ClientError("IMAGE_CONFIG_INVALID")
    except OSError:
        raise ClientError("IMAGE_CONFIG_INVALID") from None


def read_config():
    path = config_path()
    check_parent(path)
    try:
        info = path.lstat()
    except FileNotFoundError:
        raise ClientError("IMAGE_CONFIG_MISSING") from None
    except OSError:
        raise ClientError("IMAGE_CONFIG_INVALID") from None
    if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_CONFIG_BYTES:
        raise ClientError("IMAGE_CONFIG_INVALID")
    try:
        fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        with os.fdopen(fd, "rb") as source:
            opened = os.fstat(source.fileno())
            if not stat.S_ISREG(opened.st_mode) or (opened.st_dev, opened.st_ino) != (info.st_dev, info.st_ino):
                raise ClientError("IMAGE_CONFIG_INVALID")
            content = source.read(MAX_CONFIG_BYTES + 1)
        if len(content) > MAX_CONFIG_BYTES:
            raise ClientError("IMAGE_CONFIG_INVALID")
        value = json.loads(content, object_pairs_hook=_unique_object)
        if not isinstance(value, dict) or set(value) != {"version", "url"} or type(value["version"]) is not int or value["version"] != 1:
            raise ClientError("IMAGE_CONFIG_INVALID")
        return validated_url(value["url"])
    except (OSError, ValueError, UnicodeError):
        raise ClientError("IMAGE_CONFIG_INVALID") from None


def default_url(payment_network):
    """Return the endpoint for a new request that has no explicit URL.

    A host that reports its payment network selects the built-in endpoint and
    the user configuration file is not read: that file is global and cannot
    tell networks apart. Only a host that reports no network uses the file.
    """
    if payment_network is None:
        return read_config()
    if not isinstance(payment_network, str) or payment_network not in NETWORK_ENDPOINTS:
        raise ClientError("IMAGE_CONFIG_INVALID")
    return validated_url(NETWORK_ENDPOINTS[payment_network])


def write_config(url):
    url = validated_url(url)
    path = config_path()
    check_parent(path)
    try:
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        check_parent(path)
        if path.is_symlink() or (path.exists() and not path.is_file()):
            raise ClientError("IMAGE_CONFIG_INVALID")
        fd, name = tempfile.mkstemp(prefix=".image-client-", dir=path.parent)
        try:
            if hasattr(os, "fchmod"):
                os.fchmod(fd, 0o600)
            with os.fdopen(fd, "wb") as output:
                output.write(json.dumps({"version": 1, "url": url}, separators=(",", ":")).encode("utf-8"))
                output.flush()
                os.fsync(output.fileno())
            os.replace(name, path)
            if os.name != "nt":
                directory = os.open(path.parent, os.O_RDONLY)
                try:
                    os.fsync(directory)
                finally:
                    os.close(directory)
        finally:
            if os.path.exists(name):
                os.unlink(name)
    except OSError:
        raise ClientError("IMAGE_CONFIG_WRITE_FAILED") from None
