"""Keep authenticated research captures private and isolate download credentials."""

import os
from pathlib import Path
from urllib.parse import urlsplit
from uuid import uuid4


def require_access_token() -> str:
    token = os.environ.get("JSHOOK_ACCESS_TOKEN", "").strip()
    if not token:
        raise RuntimeError("Set JSHOOK_ACCESS_TOKEN in the local environment before running research scripts")
    return token


def new_capture_directory() -> Path:
    root = Path(__file__).resolve().parents[1] / "responses" / "local"
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    root.chmod(0o700)
    directory = root / str(uuid4())
    directory.mkdir(mode=0o700)
    return directory


def write_private_capture(path: Path, data: bytes) -> None:
    # Each capture has a unique filename; never overwrite a fixture or follow a symlink.
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "wb") as stream:
        stream.write(data)


def download_image(session, public_get, url: str, user_agent: str):
    parsed = urlsplit(url)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
        raise RuntimeError("Image download requires an HTTPS URL without credentials")
    # Only the exact upstream origin may receive the authenticated session.
    if parsed.hostname == "chatgpt.com" and parsed.port in (None, 443):
        response = session.get(url, timeout=120, allow_redirects=False)
    else:
        response = public_get(
            url, headers={"User-Agent": user_agent}, timeout=120,
            verify=True, allow_redirects=False,
        )
    if response.status_code != 200 or not response.headers.get("content-type", "").lower().startswith("image/"):
        response.close()
        raise RuntimeError("Image download did not return a successful image response")
    return response
