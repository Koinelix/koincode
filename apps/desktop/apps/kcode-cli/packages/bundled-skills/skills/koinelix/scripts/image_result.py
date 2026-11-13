"""Save a bounded Base64 image from a service response."""
import base64
import binascii
import json
import os
from pathlib import Path
import tempfile

from wallet_client import ClientError
from response_privacy import ResponsePrivacy

MAX_RESPONSE_BYTES = 64 * 1024 * 1024
MAX_IMAGE_BYTES = 32 * 1024 * 1024
def image_format(image):
    if image.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if image.startswith(b"\xff\xd8\xff"):
        return "jpeg"
    if len(image) >= 12 and image[:4] == b"RIFF" and image[8:12] == b"WEBP":
        return "webp"
    raise ValueError("Unsupported image signature")


def atomic_write(path, content):
    path = Path(path)
    descriptor, temporary = tempfile.mkstemp(prefix=".pending-", dir=str(path.parent))
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "wb") as output:
            output.write(content)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
        if os.name != "nt":
            directory = os.open(str(path.parent), os.O_RDONLY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def save_result(response_path, output_directory, sensitive_values=()):
    source = Path(response_path)
    if source.is_symlink() or not source.is_file() or source.stat().st_size > MAX_RESPONSE_BYTES:
        raise ClientError("IMAGE_RESPONSE_INVALID")
    try:
        data = json.loads(source.read_bytes())
        if type(data.get("created")) is not int or data["created"] < 0 or len(data["data"]) != 1:
            raise ValueError()
        encoded = data["data"][0]["b64_json"].replace("\r", "").replace("\n", "")
        if not encoded or len(encoded) > ((MAX_IMAGE_BYTES + 2) // 3) * 4:
            raise ValueError()
        image = base64.b64decode(encoded, validate=True)
        ResponsePrivacy(sensitive_values).assert_bytes(image)
        if not image or len(image) > MAX_IMAGE_BYTES or base64.b64encode(image).decode("ascii") != encoded:
            raise ValueError()
        detected_format = image_format(image)
        if data["output_format"] != detected_format:
            raise ValueError()
    except (ValueError, KeyError, TypeError, IndexError, binascii.Error, OSError):
        raise ClientError("IMAGE_RESULT_VALIDATION_FAILED") from None
    name = "generated-image." + detected_format
    target = Path(output_directory) / name
    if target.exists() or target.is_symlink():
        raise ClientError("IMAGE_OUTPUT_EXISTS")
    atomic_write(target, image)
    return {"name": name, "mediaType": "image/" + detected_format}
