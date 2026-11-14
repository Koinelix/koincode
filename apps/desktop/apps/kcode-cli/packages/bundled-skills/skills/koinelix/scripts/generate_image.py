"""Independent image business client. The wallet is used only for an actual 402."""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import ssl
import sys
import urllib.error
import urllib.request
import uuid

# Keep the installed Skill snapshot immutable when importing its sibling modules.
sys.dont_write_bytecode = True

from image_result import MAX_RESPONSE_BYTES, atomic_write, save_result
from image_config import default_url, validated_url
from wallet_client import ClientError, WalletClient
from request_store import read_state, request_lock, bind_task_request, annotate_operation_error
from request_options import request_body, access_options, assert_access, credential_for
from response_privacy import ResponsePrivacy, payment_materials

HTTP_TIMEOUT_SECONDS = 20 * 60
UUID_NAMESPACE = uuid.UUID("2aec4a19-9c57-4b1a-a5a6-1d9b1c80389b")
UNSIGNED_FAILURES = {"PAYMENTS_DISABLED": {"quoted"},
                     "PAYMENT_RECONCILIATION_REQUIRED": {"awaiting_authorization"}}
MAX_PROMPT_BYTES = 6000
EMBEDDED_BASE64 = re.compile(r"data:[^\s,]{0,100};base64,|(?<![A-Za-z0-9+/_-])[A-Za-z0-9+/_-]{512,}={0,2}", re.IGNORECASE)


def encode(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode("utf-8")


def digest(value):
    return hashlib.sha256(value).hexdigest()


def save_state(path, value):
    atomic_write(path, encode(value))


def presentable_prompt(state):
    """Return only the original, intact request input; never infer a merchant receipt."""
    try:
        body = state.get("body")
        if not isinstance(body, dict) or digest(encode(body)) != state.get("bodySha256"):
            return None
        prompt = body.get("prompt")
        if (not isinstance(prompt, str) or not prompt or "\0" in prompt
                or len(prompt) > MAX_PROMPT_BYTES or len(prompt.encode("utf-8")) > MAX_PROMPT_BYTES
                or EMBEDDED_BASE64.search(prompt)):
            return None
        return prompt
    except (ValueError, TypeError, UnicodeError):
        return None


def prompt_presentation(state):
    if state.get("promptPresentationSafe") is not True:
        return {}
    prompt = presentable_prompt(state)
    return {"presentation": {"version": 1, "clientPrompt": prompt}} if prompt is not None else {}


def mark_prompt_presentation(state, sensitive_values):
    prompt = presentable_prompt(state)
    if prompt is None:
        state["promptPresentationSafe"] = False
        return
    try:
        ResponsePrivacy(sensitive_values).assert_bytes(prompt.encode("utf-8"))
    except ClientError:
        state["promptPresentationSafe"] = False
    else:
        state["promptPresentationSafe"] = True


def mark_unsigned_failure(client, state, path):
    if state.get("phase") != "payment_authorizing" or not state.get("paymentId"):
        return
    try:
        payment = client.call("get_payment", paymentId=state["paymentId"])
    except ClientError:
        return
    if (isinstance(payment, dict) and payment.get("requestId") == state["paymentId"]
            and payment.get("transportStatus") == "failed"
            and payment.get("paymentStatus") in UNSIGNED_FAILURES.get(payment.get("diagnosticCode"), set())
            and not any(payment.get(name) for name in ("paymentIntentId", "transactionHash", "reconciliationPending"))):
        state.update({"phase": "failed", "diagnosticCode": payment["diagnosticCode"]})
        save_state(path, state)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, file, code, message, headers, url):
        return None


# Identify this client explicitly. The Python default ("Python-urllib/x.y") is
# rejected by common edge protection before the request reaches the service.
USER_AGENT = "koinelix-image-client/1"


def request_http(url, body, key, business_key, payment=None):
    headers = {"Content-Type": "application/json", "User-Agent": USER_AGENT,
               "Idempotency-Key": business_key, "Accept-Encoding": "identity"}
    if key is not None:
        headers["Authorization"] = "Bearer " + key
    if payment:
        headers["PAYMENT-SIGNATURE"] = payment
    request = urllib.request.Request(url, data=body, method="POST", headers=headers)
    opener = urllib.request.build_opener(NoRedirect(), urllib.request.HTTPSHandler(context=ssl.create_default_context()))
    try:
        response = opener.open(request, timeout=HTTP_TIMEOUT_SECONDS)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        if response.headers.get("Content-Encoding", "identity").lower() != "identity":
            raise ClientError("IMAGE_RESPONSE_ENCODING_UNSUPPORTED")
        content = response.read(MAX_RESPONSE_BYTES + 1)
        if len(content) > MAX_RESPONSE_BYTES:
            raise ClientError("IMAGE_RESPONSE_TOO_LARGE")
        return response.status, response.headers, content


def arguments():
    parser = argparse.ArgumentParser(description="Generate or recover an independent image request.")
    parser.add_argument("--url")
    parser.add_argument("--prompt")
    parser.add_argument("--model")
    parser.add_argument("--api-version", choices=("legacy-v1", "model-v1"))
    parser.add_argument("--access-mode", choices=("credentialed", "anonymous_x402"))
    parser.add_argument("--host", choices=("koincode", "reference"), default="koincode")
    parser.add_argument("--bootstrap-fd", type=int, default=4)
    parser.add_argument("--size")
    parser.add_argument("--quality")
    parser.add_argument("--output-format", choices=("png", "jpeg", "webp"))
    parser.add_argument("--output-compression", type=int, choices=range(101))
    parser.add_argument("--recover", metavar="OPERATION_ID")
    return parser.parse_args()


def reconcile_response(client, state, headers):
    """The merchant hash is only a hint; the wallet verifies the original payment."""
    claim = headers.get("PAYMENT-RESPONSE")
    if "paymentId" not in state or not isinstance(claim, str) or len(claim) > 8192:
        return
    try:
        value = json.loads(base64.b64decode(claim, validate=True).decode("utf-8"))
    except (ValueError, UnicodeError, RecursionError):
        return
    if (not isinstance(value, dict) or not isinstance(value.get("network"), str)
            or not re.fullmatch(r"eip155:[1-9][0-9]*", value["network"])):
        return
    tx = value.get("transaction")
    if not isinstance(tx, str) or not re.fullmatch(r"0x[0-9a-fA-F]{64}", tx):
        return
    try:
        client.call("reconcile_payment", paymentId=state["paymentId"], transactionHash=tx)
    except (ClientError, OSError):
        # Preserve business delivery independently of RPC or older-wallet availability.
        pass


def execute(client, args):
    url = validated_url(args.url) if args.url is not None else None
    context = client.call("context")
    if url is None and not args.recover:
        url = default_url(context.get("paymentNetwork"))
    directory = Path(context["stateDirectory"])
    output = Path(context["outputDirectory"])
    if args.recover:
        try:
            operation = str(uuid.UUID(args.recover))
        except ValueError:
            raise ClientError("IMAGE_OPERATION_INVALID") from None
    else:
        if not args.prompt or len(args.prompt) > MAX_PROMPT_BYTES or len(args.prompt.encode("utf-8")) > MAX_PROMPT_BYTES:
            raise ClientError("IMAGE_PROMPT_INVALID")
        body = request_body(args)
        operation = str(uuid.uuid5(UUID_NAMESPACE, context["taskId"] + ":" + digest(encode([url, body]))))
    # Old clients hold an exclusive directory lock. New clients share it on
    # POSIX while excluding old clients; Windows conservatively serializes.
    try:
        with request_lock(directory, shared=True):
            if args.recover:
                with request_lock(directory, ".operation-" + operation + ".lock"):
                    return execute_locked(client, args, url, context, directory, output)
            binding_id = digest(encode([context["taskId"], digest(encode(body))]))
            with request_lock(directory, ".binding-" + binding_id + ".lock"):
                bind_task_request(directory, context["taskId"], body, url, operation)
                with request_lock(directory, ".operation-" + operation + ".lock"):
                    return execute_locked(client, args, url, context, directory, output)
    except ClientError as error:
        if error.code == "IMAGE_REQUEST_CONFLICT":
            # A changed endpoint never creates a new original operation. If
            # the binding cannot prove the prior ID, omit it rather than
            # reporting the freshly computed, nonexistent candidate ID.
            original = getattr(error, "original_operation_id", None)
            if original:
                annotate_operation_error(error, directory, original)
            else:
                error.__dict__.pop("operation_id", None)
            error.outcome_status = "pending"
        else:
            annotate_operation_error(error, directory, operation)
        raise


def execute_locked(client, args, url, context, directory, output):
    if args.recover:
        try:
            operation = str(uuid.UUID(args.recover))
        except ValueError:
            raise ClientError("IMAGE_OPERATION_INVALID") from None
        state_path = directory / (operation + ".json")
        state = read_state(state_path)
        original_url = validated_url(state.get("url"))
        if url is not None and original_url != url:
            error = ClientError("IMAGE_REQUEST_CONFLICT")
            if state.get("operationId") == operation:
                error.original_operation_id = operation
            raise error
        url = original_url
    else:
        if not args.prompt or len(args.prompt) > MAX_PROMPT_BYTES or len(args.prompt.encode("utf-8")) > MAX_PROMPT_BYTES:
            raise ClientError("IMAGE_PROMPT_INVALID")
        body = request_body(args)
        raw_body = encode(body)
        operation = str(uuid.uuid5(UUID_NAMESPACE, context["taskId"] + ":" + digest(encode([url, body]))))
        state_path = directory / (operation + ".json")
        state = read_state(state_path) if state_path.exists() or state_path.is_symlink() else None
        if state is None:
            active_path = directory / "active.json"
            if active_path.exists():
                try:
                    previous = read_state(active_path)
                    if str(uuid.UUID(previous["operationId"])) == operation:
                        raise ClientError("IMAGE_REQUEST_HISTORY_INCOMPLETE")
                except (KeyError, ValueError, TypeError):
                    # Unrelated corrupt legacy metadata does not identify this operation.
                    pass
                except ClientError as error:
                    if error.code == "IMAGE_REQUEST_HISTORY_INCOMPLETE":
                        raise
            marker = directory / (operation + ".started")
            try:
                fd = os.open(str(marker), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            except FileExistsError:
                raise ClientError("IMAGE_REQUEST_HISTORY_INCOMPLETE") from None
            with os.fdopen(fd, "wb") as file:
                file.flush()
                os.fsync(file.fileno())
            if os.name != "nt":
                fd = os.open(str(directory), os.O_RDONLY)
                try:
                    os.fsync(fd)
                finally:
                    os.close(fd)
            state = {"version": 1, "operationId": operation, "taskId": context["taskId"], "url": url, "body": body,
                     "bodySha256": digest(raw_body), "businessKey": str(uuid.uuid4()), "phase": "prepared",
                     **access_options(args)}
            save_state(state_path, state)
        else:
            mark_unsigned_failure(client, state, state_path)
    try:
        assert_access(state, args)
    except ClientError as error:
        if error.code == "IMAGE_REQUEST_CONFLICT":
            error.original_operation_id = operation
        raise
    try:
        response_path = directory / (operation + ".response.json")
        if response_path.exists():
            if state.get("responsePrivacyVersion") != 1 or state.get("responseSha256") != digest(response_path.read_bytes()):
                return {"status": "pending", "diagnosticCode": "IMAGE_RESPONSE_REQUIRES_REVIEW",
                        "operationId": operation, "artifacts": []}
            artifact = save_result(response_path, output)
            state["phase"] = "complete"
            save_state(state_path, state)
            return {"status": "recovered", "operationId": operation,
                    **({"paymentId": state["paymentId"]} if "paymentId" in state else {}), "artifacts": [artifact],
                    **prompt_presentation(state)}
        if not args.recover and state["phase"] == "failed":
            return {"status": "failed", "diagnosticCode": state.get("diagnosticCode", "IMAGE_REQUEST_FAILED"),
                    "operationId": operation, **({"paymentId": state["paymentId"]} if "paymentId" in state else {}), "artifacts": []}
        if args.recover or state["phase"] != "prepared":
            return {"status": "pending", "diagnosticCode": "IMAGE_REQUEST_OUTCOME_UNKNOWN",
                    "operationId": operation, **({"paymentId": state["paymentId"]} if "paymentId" in state else {}), "artifacts": []}
        credential = credential_for(client, state, url)
        sensitive_values = [credential["secret"]] if credential["secret"] is not None else []
        body = encode(state["body"])
        if digest(body) != state["bodySha256"]:
            raise ClientError("IMAGE_REQUEST_STATE_INVALID")
        state.update({"credentialTag": credential["credentialTag"], "phase": "initial_sending"})
        save_state(state_path, state)
        status, headers, content = request_http(url, body, credential["secret"], state["businessKey"])
        if status == 402:
            challenge = headers.get("PAYMENT-REQUIRED")
            if not challenge:
                state["phase"] = "failed"
                save_state(state_path, state)
                raise ClientError("X402_INVALID_CHALLENGE")
            payment = {"url": url, "method": "POST", "bodySha256": digest(body), "bodyByteLength": len(body),
                       "credentialTag": credential["credentialTag"], "paymentRequired": challenge,
                       "requestDigest": digest(encode([url, "POST", digest(body), state["businessKey"], credential["credentialTag"]]))}
            state["phase"] = "payment_preparing"
            save_state(state_path, state)
            prepared = client.call("prepare_payment", operationId=operation, payment=payment)
            state.update({"paymentId": prepared["paymentId"], "phase": "payment_authorizing"})
            save_state(state_path, state)
            signed = client.call("authorize_payment", paymentId=state["paymentId"])
            sensitive_values.extend(payment_materials(signed["paymentHeader"]))
            state.update({"intentId": signed["intentId"], "phase": "paid_sending"})
            save_state(state_path, state)
            status, headers, content = request_http(url, body, credential["secret"], state["businessKey"], signed["paymentHeader"])
            signed.clear()
        if status != 200:
            reconcile_response(client, state, headers)
            state.update({"httpStatus": status, "phase": "unknown" if "paymentId" in state else "failed"})
            save_state(state_path, state)
            return {"status": "pending" if "paymentId" in state else "failed",
                    "diagnosticCode": "IMAGE_SERVICE_HTTP_" + str(status), "operationId": operation,
                    **({"paymentId": state["paymentId"]} if "paymentId" in state else {}), "artifacts": []}
        ResponsePrivacy(sensitive_values).inspect_response(content)
        mark_prompt_presentation(state, sensitive_values)
        state.update({"phase": "response_saving", "responsePrivacyVersion": 1, "responseSha256": digest(content)})
        save_state(state_path, state)
        atomic_write(response_path, content)
        state["phase"] = "response_saved"
        save_state(state_path, state)
        reconcile_response(client, state, headers)
        artifact = save_result(response_path, output, sensitive_values)
        state["phase"] = "complete"
        save_state(state_path, state)
        return {"status": "completed", "operationId": operation,
                **({"paymentId": state["paymentId"]} if "paymentId" in state else {}), "artifacts": [artifact],
                **prompt_presentation(state)}
    except ClientError as error:
        if error.code in UNSIGNED_FAILURES:
            mark_unsigned_failure(client, state, state_path)
        error.operation_id = operation
        error.payment_id = state.get("paymentId")
        raise
    except (OSError, ValueError, KeyError, TypeError, urllib.error.URLError):
        error = ClientError("IMAGE_CLIENT_OUTCOME_UNKNOWN")
        error.operation_id = operation
        error.payment_id = state.get("paymentId")
        raise error from None


def main():
    client = None
    try:
        args = arguments()
        if getattr(args, "host", "koincode") == "reference":
            from reference_host import ReferenceHost
            client = ReferenceHost(args.bootstrap_fd)
        else:
            client = WalletClient()
        result = execute(client, args)
    except ClientError as error:
        code = error.code if re.fullmatch(r"[A-Z][A-Z0-9_]{0,79}", str(error.code)) else "IMAGE_CLIENT_FAILED"
        result = {"status": getattr(error, "outcome_status", "failed"), "diagnosticCode": code, "artifacts": []}
        if getattr(error, "operation_id", None):
            result["operationId"] = error.operation_id
        if getattr(error, "payment_id", None):
            result["paymentId"] = error.payment_id
    except (OSError, ValueError, KeyError, TypeError, urllib.error.URLError):
        result = {"status": "pending", "diagnosticCode": "IMAGE_CLIENT_OUTCOME_UNKNOWN", "artifacts": []}
    finally:
        if client:
            client.close()
    sys.stdout.write(json.dumps(result, separators=(",", ":")) + "\n")


if __name__ == "__main__":
    main()
