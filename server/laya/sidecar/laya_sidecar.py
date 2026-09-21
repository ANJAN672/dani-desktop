#!/usr/bin/env python3
"""Laya inference sidecar for DANI (spec 100 R4).

One long-lived process, newline-delimited JSON on stdin/stdout. The Node
server owns lifecycle; this process owns exactly one resident checkpoint.

Request : {"id": str, "method": "ping"|"load"|"predict"|"unload"|"download", "params": {...}}
Response: {"id": str, "ok": true, "result": {...}} | {"id": str, "ok": false, "error": {"kind": str, "message": str}}

Anything on stdout that is not a response line is a protocol violation;
diagnostics go to stderr only.
"""
import hashlib
import json
import os
import sys

# transformers probes for TensorFlow at import; with TF installed its abseil
# runtime can deadlock model construction. Vendor-documented workaround.
os.environ.setdefault("USE_TF", "0")

_AGENT = None
_AGENT_IDENTITY = None


def _emit(response):
    sys.stdout.write(json.dumps(response) + "\n")
    sys.stdout.flush()


def _fail(req_id, kind, message):
    _emit({"id": req_id, "ok": False, "error": {"kind": kind, "message": str(message)}})


def _ok(req_id, result):
    _emit({"id": req_id, "ok": True, "result": result})


def _import_laya():
    try:
        import laya  # noqa: F401
        return laya
    except Exception as exc:  # ImportError or a transitive failure
        raise RuntimeError(f"SDK_UNAVAILABLE: {exc}") from exc


def _cmd_load(req_id, params):
    """Load the pinned checkpoint from its verified local snapshot directory.

    The SDK's laya.load() accepts no revision pin, so the Node service hands
    us the exact local directory produced by the hash-verified `download`
    step. Loading from a local path makes the SDK skip the network entirely.
    """
    global _AGENT, _AGENT_IDENTITY
    model_dir = params["model_dir"]
    if not os.path.isdir(model_dir):
        _fail(req_id, "NOT_INSTALLED", f"model directory not found: {model_dir}")
        return
    subfolder = params.get("subfolder") or None
    device = params.get("device")  # None => SDK picks cuda when available
    identity = params.get("identity") or {}
    laya = _import_laya()
    kwargs = {}
    if subfolder:
        kwargs["subfolder"] = subfolder
    if device:
        kwargs["device"] = device
    agent = laya.load(model_dir, **kwargs)
    _AGENT = agent
    _AGENT_IDENTITY = {
        "repo": identity.get("repo", ""),
        "subfolder": subfolder or "",
        "revision": identity.get("revision", ""),
    }
    _ok(req_id, {"loaded": True, **_AGENT_IDENTITY})


def _cmd_unload(req_id, _params):
    global _AGENT, _AGENT_IDENTITY
    _AGENT = None
    _AGENT_IDENTITY = None
    try:
        import torch

        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:
        pass
    _ok(req_id, {"loaded": False})


def _cmd_predict(req_id, params):
    if _AGENT is None:
        _fail(req_id, "NOT_LOADED", "no checkpoint is loaded")
        return
    state = params["state"]
    questions = params["questions"]
    result = _AGENT.predict(state, questions)
    _ok(req_id, {"identity": _AGENT_IDENTITY, "raw": result})


def _sha256(path, expected_bytes):
    h = hashlib.sha256()
    total = 0
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
            total += len(chunk)
    if total != expected_bytes:
        raise RuntimeError(f"HASH_MISMATCH: {path} is {total} bytes, expected {expected_bytes}")
    return h.hexdigest()


def _cmd_download(req_id, params):
    """Consented lazy download of one pinned checkpoint + sha256 verification.

    params: repo, revision, files: [{path, bytes, sha256?}], cache_dir.
    Only files with an LFS sha256 are hash-verified; small git-blob files are
    covered by the pinned revision. Returns the verified file list.
    """
    try:
        from huggingface_hub import hf_hub_download
    except Exception as exc:
        raise RuntimeError(f"SDK_UNAVAILABLE: {exc}") from exc
    repo = params["repo"]
    revision = params["revision"]
    verified = []
    for f in params["files"]:
        local = hf_hub_download(repo_id=repo, filename=f["path"], revision=revision,
                                cache_dir=params.get("cache_dir") or None)
        entry = {"path": f["path"], "local": local}
        if f.get("sha256"):
            digest = _sha256(local, int(f["bytes"]))
            if digest != f["sha256"]:
                raise RuntimeError(
                    f"HASH_MISMATCH: {f['path']} sha256 {digest} != pinned {f['sha256']}")
            entry["sha256"] = digest
        verified.append(entry)
    _ok(req_id, {"verified": verified})


_METHODS = {"load": _cmd_load, "unload": _cmd_unload, "predict": _cmd_predict, "download": _cmd_download}


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        req_id = None
        try:
            req = json.loads(line)
            req_id = req.get("id")
            method = req.get("method")
            if method == "ping":
                _ok(req_id, {"pong": True, "loaded": _AGENT is not None, "identity": _AGENT_IDENTITY})
                continue
            handler = _METHODS.get(method)
            if handler is None:
                _fail(req_id, "BAD_METHOD", f"unknown method {method!r}")
                continue
            handler(req_id, req.get("params") or {})
        except RuntimeError as exc:
            msg = str(exc)
            kind, _, detail = msg.partition(":")
            if kind in ("SDK_UNAVAILABLE", "HASH_MISMATCH"):
                _fail(req_id, kind, detail.strip() or msg)
            else:
                _fail(req_id, "SIDECAR_ERROR", msg)
        except Exception as exc:  # model/runtime errors stay typed, never crash the loop
            _fail(req_id, "SIDECAR_ERROR", f"{type(exc).__name__}: {exc}")


if __name__ == "__main__":
    main()
