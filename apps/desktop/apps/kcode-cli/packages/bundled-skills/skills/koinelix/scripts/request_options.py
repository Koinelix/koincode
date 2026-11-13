"""Current public image API defaults; preserve every saved request's access mode."""
from wallet_client import ClientError

ACCESS_MODES = {"credentialed", "anonymous_x402"}
API_VERSIONS = {"legacy-v1", "model-v1"}
LEGACY_FIELDS = ("size", "quality", "output_format", "output_compression")


def access_options(args):
    mode = getattr(args, "access_mode", None) or "anonymous_x402"
    version = getattr(args, "api_version", None) or "model-v1"
    if mode not in ACCESS_MODES or version not in API_VERSIONS:
        raise ClientError("IMAGE_ACCESS_CONFIG_INVALID")
    if mode == "anonymous_x402" and version != "model-v1":
        raise ClientError("IMAGE_API_VERSION_REQUIRED")
    return {"accessMode": mode, "apiVersion": version}


def request_body(args):
    options = access_options(args)
    body = {"prompt": args.prompt}
    model = getattr(args, "model", None)
    if options["apiVersion"] == "model-v1":
        if model is not None and (not isinstance(model, str) or not model.strip() or model != model.strip() or len(model) > 128
                or any(ord(char) < 32 or ord(char) == 127 for char in model)):
            raise ClientError("IMAGE_MODEL_REQUIRED")
        if any(getattr(args, name, None) is not None for name in LEGACY_FIELDS):
            raise ClientError("IMAGE_API_PARAMETER_UNSUPPORTED")
        if model is not None:
            body["model"] = model
    else:
        if model is not None:
            raise ClientError("IMAGE_API_PARAMETER_UNSUPPORTED")
        for name in LEGACY_FIELDS:
            value = getattr(args, name, None)
            if value is not None:
                body[name] = value
    return body


def assert_access(state, args):
    # Historical records were credentialed and used the pre-model API. Never
    # infer anonymous access from the absence of a saved mode.
    mode = state.get("accessMode", "credentialed")
    version = state.get("apiVersion", "legacy-v1")
    if mode not in ACCESS_MODES or version not in API_VERSIONS:
        raise ClientError("IMAGE_REQUEST_STATE_INVALID")
    requested_mode = getattr(args, "access_mode", None)
    requested_version = getattr(args, "api_version", None)
    if ((requested_mode is not None and requested_mode != mode)
            or (requested_version is not None and requested_version != version)
            or (not args.recover and access_options(args) != {"accessMode": mode, "apiVersion": version})):
        raise ClientError("IMAGE_REQUEST_CONFLICT")


def credential_for(client, state, url):
    if state.get("accessMode", "credentialed") == "anonymous_x402":
        return {"secret": None, "credentialTag": None}
    return client.call("credential.read", url=url)
