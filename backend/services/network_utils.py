import asyncio
import logging
import json
import subprocess
import shutil
import time
import httpx
from urllib.parse import urlparse

logger = logging.getLogger(__name__)

# Reusable httpx client with connection pooling and connection-level retry.
# connect 실패 시 1회만 재시도 (서버가 아예 안 되면 반복해도 무의미).
# 기존 requests.Session(pool_maxsize=20, Retry total=1)의 풀링/재시도 의도를 유지한다.
_limits = httpx.Limits(max_connections=20, max_keepalive_connections=20)
_transport = httpx.HTTPTransport(retries=1)
_client = httpx.Client(limits=_limits, transport=_transport, follow_redirects=True)

# Find bash for curl fallback — Git bash's curl has the TLS features
# needed to pass CDN fingerprint checks (brotli, zstd, libpsl)
_BASH_PATH = shutil.which("bash") or "bash"

# Cache domains where the HTTP client fails — skip straight to curl for 5 minutes
_domain_fail_cache: dict[str, float] = {}
_DOMAIN_FAIL_TTL = 300  # 5 minutes

class _DummyResponse:
    """Minimal response object matching the requests/httpx response interface."""
    def __init__(self, status_code, text):
        self.status_code = status_code
        self.text = text
        self.content = text.encode('utf-8', errors='replace')

    def json(self):
        return json.loads(self.text)

    def raise_for_status(self):
        if self.status_code >= 400:
            raise Exception(f"HTTP {self.status_code}: {self.text[:100]}")


def _run_curl_fallback(url, method, json_data, timeout, default_headers):
    """Run the curl subprocess fallback. Always returns a _DummyResponse.

    Falls back to running curl through Git bash, which has the TLS features
    (brotli, zstd, libpsl) needed to pass CDN fingerprint checks that block
    both Python HTTP clients and the barebones Windows system curl.
    """
    # Build curl as argument list — never pass through shell to prevent injection
    _CURL_PATH = shutil.which("curl") or "curl"
    cmd = [_CURL_PATH, "-s", "-w", "\n%{http_code}"]
    for k, v in default_headers.items():
        cmd += ["-H", f"{k}: {v}"]
    if method == "POST" and json_data:
        cmd += ["-X", "POST", "-H", "Content-Type: application/json",
                "--data-binary", "@-"]
    cmd.append(url)

    stdin_data = json.dumps(json_data) if (method == "POST" and json_data) else None
    try:
        res = subprocess.run(
            cmd, capture_output=True, text=True, timeout=timeout + 5,
            input=stdin_data
        )
    except subprocess.TimeoutExpired:
        logger.error(f"bash curl fallback timed out after {timeout + 5}s for {url}")
        return _DummyResponse(504, "")
    except Exception as curl_e:
        logger.error(f"bash curl fallback exception: {curl_e}")
        return _DummyResponse(500, "")

    if res.returncode == 0 and res.stdout.strip():
        # Parse HTTP status code from -w output (last line)
        lines = res.stdout.rstrip().rsplit("\n", 1)
        body = lines[0] if len(lines) > 1 else res.stdout
        http_code = int(lines[-1]) if len(lines) > 1 and lines[-1].strip().isdigit() else 200
        return _DummyResponse(http_code, body)

    logger.error(f"bash curl fallback failed: exit={res.returncode} stderr={res.stderr[:200]}")
    return _DummyResponse(500, "")


def fetch_with_curl(url, method="GET", json_data=None, timeout=15, headers=None):
    """Wrapper to bypass aggressive local firewall that blocks Python but permits curl.

    Tries httpx first (connection pooled), then falls back to running curl through
    Git bash. Signature is unchanged from the previous requests-based version so the
    synchronous background-thread callers keep working as-is.
    """
    default_headers = {
        "User-Agent": "ShadowBroker-OSINT/1.0 (live-risk-dashboard)",
    }
    if headers:
        default_headers.update(headers)

    domain = urlparse(url).netloc

    # Check if this domain recently failed — skip straight to curl
    if domain in _domain_fail_cache and (time.time() - _domain_fail_cache[domain]) < _DOMAIN_FAIL_TTL:
        pass  # Fall through to curl below
    else:
        try:
            if method == "POST":
                res = _client.post(url, json=json_data, timeout=timeout, headers=default_headers)
            else:
                res = _client.get(url, timeout=timeout, headers=default_headers)
            res.raise_for_status()
            # Clear failure cache on success
            _domain_fail_cache.pop(domain, None)
            return res
        except Exception as e:
            logger.warning(f"Python httpx failed for {url} ({e}), falling back to bash curl...")
            _domain_fail_cache[domain] = time.time()

    return _run_curl_fallback(url, method, json_data, timeout, default_headers)


async def fetch_with_curl_async(url, method="GET", json_data=None, timeout=15, headers=None):
    """Async-safe variant of fetch_with_curl.

    Runs the blocking httpx/subprocess fetch in a worker thread via
    asyncio.to_thread so the event loop is never blocked by network or
    subprocess I/O. Returns the same response object as fetch_with_curl.
    """
    return await asyncio.to_thread(
        fetch_with_curl, url, method, json_data, timeout, headers
    )
