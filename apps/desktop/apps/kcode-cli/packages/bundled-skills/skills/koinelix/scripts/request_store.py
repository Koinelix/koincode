"""Durable business request identity and bounded local locking; no wallet state."""
import contextlib
import hashlib
import json
import os
import uuid
from wallet_client import ClientError
from image_config import validated_url

UNSIGNED_FAILURES = {"PAYMENTS_DISABLED": {"quoted"},
                     "PAYMENT_RECONCILIATION_REQUIRED": {"awaiting_authorization"}}

UUID_NAMESPACE = uuid.UUID("2aec4a19-9c57-4b1a-a5a6-1d9b1c80389b")

def encode(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode("utf-8")

def digest(value):
    return hashlib.sha256(value).hexdigest()

def read_state(path):
    if path.is_symlink() or not path.is_file() or path.stat().st_size > 128 * 1024:
        raise ClientError("IMAGE_REQUEST_STATE_INVALID")
    try:
        return json.loads(path.read_bytes())
    except (ValueError, UnicodeError):
        raise ClientError("IMAGE_REQUEST_STATE_INVALID") from None


@contextlib.contextmanager
def request_lock(directory, name=".request.lock", shared=False):
    path = directory / name
    if path.is_symlink():
        raise ClientError("IMAGE_REQUEST_STATE_INVALID")
    with open(path, "a+b") as handle:
        if os.name == "nt":
            import msvcrt
            if path.stat().st_size == 0:
                handle.write(b"0")
                handle.flush()
            handle.seek(0)
            try:
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            except OSError:
                raise ClientError("IMAGE_REQUEST_BUSY") from None
        else:
            import fcntl
            try:
                fcntl.flock(handle.fileno(), (fcntl.LOCK_SH if shared else fcntl.LOCK_EX) | fcntl.LOCK_NB)
            except OSError:
                raise ClientError("IMAGE_REQUEST_BUSY") from None
        yield


def matches_original_state(directory, task_id, body, original_url, original_id):
    try:
        state = read_state(directory / (original_id + ".json"))
        return (isinstance(state, dict) and state.get("operationId") == original_id
                and state.get("url") == original_url and state.get("body") == body
                and ("taskId" not in state or state["taskId"] == task_id))
    except (ClientError, OSError, ValueError, TypeError):
        return False


def bind_task_request(directory, task_id, body, url, operation):
    """Freeze the target of one task/body before any business HTTP or signing.

    Caller holds the corresponding task/body lock and the legacy directory
    lock. Existing legacy records are considered before creating the binding.
    """
    body_sha = digest(encode(body))
    binding_id = digest(encode([task_id, body_sha]))
    path = directory / (".binding-" + binding_id + ".json")
    expected = {"version": 1, "url": url, "operationId": operation}
    if path.exists() or path.is_symlink():
        existing = read_state(path)
        if existing != expected:
            error = ClientError("IMAGE_REQUEST_CONFLICT")
            try:
                # Only expose an original identity that is deterministically
                # bound to this exact task/body and the stored original URL.
                if (isinstance(existing, dict) and set(existing) == set(expected)
                        and type(existing["version"]) is int and existing["version"] == 1):
                    original_url = validated_url(existing["url"])
                    original_id = str(uuid.uuid5(UUID_NAMESPACE, task_id + ":" + digest(encode([original_url, body]))))
                    if (existing["operationId"] == original_id
                            and matches_original_state(directory, task_id, body, original_url, original_id)):
                        error.original_operation_id = original_id
            except (ClientError, KeyError, TypeError, ValueError):
                pass
            raise error
        # The creator may have crashed after writing but before syncing.
        # Establish durability again before any caller is allowed to send.
        fd = os.open(str(path), os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
        if os.name != "nt":
            fd = os.open(str(directory), os.O_RDONLY)
            try:
                os.fsync(fd)
            finally:
                os.close(fd)
        return

    for candidate in directory.glob("*.json"):
        try:
            candidate_id = str(uuid.UUID(candidate.stem))
        except ValueError:
            continue
        try:
            prior = read_state(candidate)
            prior_body = prior["body"]
            prior_url = validated_url(prior["url"])
            if not isinstance(prior, dict) or digest(encode(prior_body)) != body_sha:
                continue
            old_id = str(uuid.uuid5(UUID_NAMESPACE, task_id + ":" + digest(encode([prior_url, prior_body]))))
            if "taskId" in prior:
                belongs = prior["taskId"] == task_id
                if belongs and old_id != candidate_id:
                    raise ClientError("IMAGE_REQUEST_HISTORY_INCOMPLETE")
            else:
                belongs = old_id == candidate_id
            if belongs and (candidate_id != operation or prior_url != url):
                error = ClientError("IMAGE_REQUEST_CONFLICT")
                if prior.get("operationId") == candidate_id:
                    error.original_operation_id = candidate_id
                raise error
        except (KeyError, ValueError, TypeError):
            # A malformed unrelated history record cannot identify this task.
            continue
        except ClientError as error:
            if error.code in {"IMAGE_REQUEST_CONFLICT", "IMAGE_REQUEST_HISTORY_INCOMPLETE"}:
                raise
            # The current operation still validates its own record below.
            continue

    # Create in place, rather than rename: a crash can leave an incomplete
    # binding but must never make a previously started task appear new.
    try:
        fd = os.open(str(path), os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
    except FileExistsError:
        raise ClientError("IMAGE_REQUEST_HISTORY_INCOMPLETE") from None
    with os.fdopen(fd, "wb") as output:
        output.write(encode(expected))
        output.flush()
        os.fsync(output.fileno())
    if os.name != "nt":
        fd = os.open(str(directory), os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)


def annotate_operation_error(error, directory, operation):
    """Classify from durable state; errors never turn an unknown outcome into failure."""
    error.operation_id = operation
    error.outcome_status = "pending"
    if error.code == "IMAGE_REQUEST_BUSY":
        return
    path = directory / (operation + ".json")
    try:
        try:
            path.lstat()
        except FileNotFoundError:
            # A marker without its state is an incomplete history, not proof
            # that a previous attempt was never sent.
            marker = directory / (operation + ".started")
            try:
                marker.lstat()
            except FileNotFoundError:
                if error.code not in {"IMAGE_REQUEST_CONFLICT", "IMAGE_REQUEST_HISTORY_INCOMPLETE",
                                      "IMAGE_REQUEST_STATE_INVALID"}:
                    error.outcome_status = "failed"
            return
        state = read_state(path)
        if not isinstance(state, dict):
            return
        payment_id = state.get("paymentId")
        if isinstance(payment_id, str):
            error.payment_id = payment_id
        phase = state.get("phase")
        if phase == "prepared" and not payment_id:
            error.outcome_status = "failed"
        elif phase == "failed" and not state.get("intentId"):
            if not payment_id or state.get("diagnosticCode") in UNSIGNED_FAILURES:
                error.outcome_status = "failed"
    except (ClientError, OSError, ValueError, TypeError):
        # Missing or unreadable evidence cannot establish an unsigned failure.
        pass

