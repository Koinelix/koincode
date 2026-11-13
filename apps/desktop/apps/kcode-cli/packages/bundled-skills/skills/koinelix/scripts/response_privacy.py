"""Withhold known request secrets before a business response or image is persisted."""
import base64
import binascii
import json
import re
from urllib.parse import quote

from wallet_client import ClientError


def payment_materials(header):
    values = [header]
    try:
        decoded = json.loads(base64.b64decode(header, validate=True))
    except (ValueError, UnicodeError, binascii.Error):
        return values
    stack = [decoded]
    while stack:
        value = stack.pop()
        if isinstance(value, dict):
            for name, child in value.items():
                if name.lower() == "signature" and isinstance(child, str):
                    values.append(child)
                elif isinstance(child, (dict, list)):
                    stack.append(child)
        elif isinstance(value, list):
            stack.extend(value)
    return values


class ResponsePrivacy:
    def __init__(self, secrets):
        variants = set()
        for secret in secrets:
            if not isinstance(secret, str) or not secret:
                continue
            raw = secret.encode("utf-8")
            variants.update((raw, b"Bearer " + raw, raw.hex().encode("ascii"),
                             base64.b64encode(raw), base64.urlsafe_b64encode(raw),
                             quote(secret, safe="").encode("ascii"),
                             json.dumps(secret, ensure_ascii=True)[1:-1].encode("utf-8")))
        self.variants = tuple(value for value in variants if value)

    def assert_bytes(self, content):
        if any(value in content for value in self.variants):
            raise ClientError("IMAGE_RESPONSE_CONTAINS_SECRET")

    def inspect_response(self, content):
        self.assert_bytes(content)
        try:
            value = json.loads(content, object_pairs_hook=lambda pairs: [part for pair in pairs for part in pair])
        except (ValueError, UnicodeError, RecursionError):
            raise ClientError("IMAGE_RESPONSE_INVALID") from None
        stack = [value]
        while stack:
            value = stack.pop()
            if isinstance(value, list):
                stack.extend(value)
            elif isinstance(value, str):
                self.assert_bytes(value.encode("utf-8"))
                candidate = value.replace("\r", "").replace("\n", "")
                if candidate and re.fullmatch(r"[A-Za-z0-9+/_-]+={0,2}", candidate):
                    try:
                        self.assert_bytes(base64.b64decode(candidate + "=" * (-len(candidate) % 4), altchars=b"-_", validate=True))
                    except (ValueError, binascii.Error):
                        pass
