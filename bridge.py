#!/usr/bin/env python3
import sys
import re
import os
import json
import subprocess
import signal
import fcntl
import select
import time
import socket
import ipaddress
import math
import threading
import collections
import urllib.request
import urllib.error
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone


DEFAULT_VPN_PORT = 9735
DATA_DIR = os.getenv("DATA_DIR", "/data")
CONFIG_PATH = os.path.join(DATA_DIR, "tunnelsatsv3.conf")
APP_CONFIG_PATH = os.path.join(DATA_DIR, "config.json")
META_FILE_PATH = os.path.join(DATA_DIR, "tunnelsats-meta.json")
# Written ONLY by the Connect Wallet action (startos/actions/connectWallet.ts);
# excluded from StartOS backups and never read by get_dashboard().
NWC_WALLET_FILE_PATH = os.path.join(DATA_DIR, "nwc-wallet.json")
# Written by the TypeScript side (startos/fileModels); only read here, by the
# dashboard read model (get_dashboard).
HANDOFF_FILE_PATH = os.path.join(DATA_DIR, "vpn-handoff.json")
NOTICES_FILE_PATH = os.path.join(DATA_DIR, "subscription-notices.json")
# Written ONLY here (POST /api/intents); read by the TypeScript intentRunner.
INTENTS_FILE_PATH = os.path.join(DATA_DIR, "dashboard-intents.json")
# Written ONLY by the TypeScript intentRunner; read here by get_dashboard.
INTENT_RESULTS_FILE_PATH = os.path.join(DATA_DIR, "dashboard-intent-results.json")
TUNNELSATS_API_URL = "https://tunnelsats.com/api/public/v1"
# Fields that only hold for the key they were confirmed for (see lazy_sync).
CONFIRMED_META_FIELDS = ("expiresAt", "expirySource", "lastSync", "syncSuccess", "bandwidth_used_gb",
                         "bandwidth_limit_gb", "bandwidth_resets_this_month", "max_resets_per_month")
# The unknown-key state (see _record_not_found) belongs to one key as well.
KEY_BOUND_META_FIELDS = CONFIRMED_META_FIELDS + ("keyUnknown", "notFoundSince")
# The status endpoint's error code for "no subscription for this key".
STATUS_NOT_FOUND_CODE = "ERR_RESOURCE_NOT_FOUND"
# How long a key the API confirmed before must keep answering "not found"
# before it counts as unknown. The endpoint also answers 404 while one of
# its servers is unreachable, so a single answer proves nothing for it.
# Once tunnelsats-v2-web#309 ships (503 when a server check errored), a 404
# is definitive and this grace period can go.
UNKNOWN_KEY_CONFIRM_AFTER = timedelta(hours=24)
# The same for a key the API never confirmed (e.g. a fresh purchase that
# meets that outage, or an import). Short, so a mistyped import is reported
# on its second answer (next_sync_delay("not-found") waits at least this).
NEW_KEY_UNKNOWN_AFTER = timedelta(minutes=15)
UNKNOWN_KEY_MESSAGE = (
    "TunnelSats has no subscription for the WireGuard key in this configuration. "
    "Import a valid configuration or buy a subscription."
)
NOT_FOUND_PENDING_MESSAGE = (
    "TunnelSats did not find this WireGuard key. This can be a temporary server problem; checking again."
)

os.umask(0o077)

_enabled_cache = None
_enabled_cache_mtime = 0
_pubkey_cache = None
_csrf_token = None

def get_csrf_token():
    global _csrf_token
    if _csrf_token is None:
        import secrets
        _csrf_token = secrets.token_hex(32)
    return _csrf_token

def validate_csrf_token(token):
    if not token or not isinstance(token, str):
        return False
    import hmac
    return hmac.compare_digest(token.strip(), get_csrf_token())


def parse_config_comments(config_content):
    meta = {}
    for line in config_content.splitlines():
        line = line.strip()
        if match := re.match(r"^#\s*Valid Until:\s*(.+)", line, re.IGNORECASE):
            meta["expiresAt"] = match.group(1).strip()
        elif match := re.match(r"^#\s*(?:VPNPort|Port Forwarding):\s*(\d+)", line, re.IGNORECASE):
            meta["vpnPort"] = int(match.group(1))
        elif match := re.match(r"^#\s*Server:\s*(.+)", line, re.IGNORECASE):
            meta["serverDomain"] = match.group(1).strip()
    return meta

def is_valid_iso_expiry(expiry_str):
    if not expiry_str:
        return False
    try:
        # ISO format like "2026-10-02T21:18:07.000Z"
        datetime.fromisoformat(expiry_str.replace("Z", "+00:00"))
        return True
    except Exception:
        return False

def atomic_write_json(filepath, data, mode=0o600):
    tmp_path = filepath + ".tmp"
    try:
        content = json.dumps(data, indent=2)
        fd = os.open(tmp_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, mode)
        with os.fdopen(fd, 'w') as f:
            f.write(content)
        os.replace(tmp_path, filepath)
        try:
            os.chmod(filepath, mode)
        except Exception:
            pass
    except Exception as e:
        if os.path.exists(tmp_path):
            try:
                os.remove(tmp_path)
            except Exception:
                pass
        raise e

def atomic_write_file(filepath, content, mode=0o600):
    tmp_path = filepath + ".tmp"
    try:
        fd = os.open(tmp_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, mode)
        with os.fdopen(fd, 'w') as f:
            f.write(content)
        os.replace(tmp_path, filepath)
        try:
            os.chmod(filepath, mode)
        except Exception:
            pass
    except Exception as e:
        if os.path.exists(tmp_path):
            try:
                os.remove(tmp_path)
            except Exception:
                pass
        raise e

@contextmanager
def meta_lock():
    """Exclusive cross-process lock around every read-modify-write of the
    metadata file, and of config.json and the conf file. The dashboard's
    sync thread, the forced sync, the health check (a separate process) and
    save_configuration all rewrite them; without the lock one writer can
    replace another's newer result with metadata it loaded before a slow API
    request. The TypeScript writers (the Buy/Renew/Reset record, Configure,
    Import) take the same lock through `bridge.py meta-lock`
    (hold_meta_lock, startos/metaLock.ts). Every writer still merges into a
    fresh read taken under the lock, never into data it loaded before."""
    fd = os.open(META_FILE_PATH + ".lock", os.O_RDWR | os.O_CREAT, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        yield
    finally:
        os.close(fd)

META_LOCK_ACQUIRE_TIMEOUT = 30
META_LOCK_LEASE = 30
META_LOCK_EXIT_BUSY = 2
META_LOCK_EXIT_LEASE = 3

def hold_meta_lock(stdin_fd, out, acquire_timeout=META_LOCK_ACQUIRE_TIMEOUT, lease=META_LOCK_LEASE):
    """meta_lock for a process that cannot flock (the TypeScript runtime):
    takes the same lock file, writes "locked" to `out`, and holds the lock
    until `stdin_fd` reaches EOF, which is how the owner releases it (the
    holder then writes "released" before closing the lock file). An owner
    that dies closes the pipe, so its lock is released as well.

    The owner keeps the hold alive by writing to stdin (a heartbeat); every
    write renews the lease. A slow file operation therefore never loses the
    lock while its owner is alive, but an owner that hangs (a blocked event
    loop sends no heartbeat) cannot block bridge.py's writers forever.

    Returns 0 after a release, META_LOCK_EXIT_BUSY (after writing a JSON
    error, never "locked") when the lock stays taken for acquire_timeout
    seconds, and META_LOCK_EXIT_LEASE when the owner sent neither a
    heartbeat nor EOF for `lease` seconds. The owner treats any exit without
    "released" as a lost lock and fails its job."""
    fd = os.open(META_FILE_PATH + ".lock", os.O_RDWR | os.O_CREAT, 0o600)
    try:
        deadline = time.monotonic() + acquire_timeout
        while True:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    out.write(json.dumps({"error": "Timed out waiting for the TunnelSats metadata lock"}) + "\n")
                    out.flush()
                    return META_LOCK_EXIT_BUSY
                readable, _, _ = select.select([stdin_fd], [], [], min(0.02, remaining))
                if readable and not os.read(stdin_fd, 4096):
                    try:
                        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                        break
                    except BlockingIOError:
                        # The owner disconnected while the lock is still busy.
                        return 0
        try:
            out.write("locked\n")
            out.flush()
        except (BrokenPipeError, OSError):
            # The owner is gone before it got the lock: nothing to hold.
            return 0
        lease_end = time.monotonic() + lease
        while True:
            remaining = lease_end - time.monotonic()
            if remaining <= 0:
                return META_LOCK_EXIT_LEASE
            readable, _, _ = select.select([stdin_fd], [], [], remaining)
            if readable:
                if not os.read(stdin_fd, 4096):
                    try:
                        out.write("released\n")
                        out.flush()
                    except (BrokenPipeError, OSError):
                        pass
                    return 0
                lease_end = time.monotonic() + lease
    finally:
        os.close(fd)

def read_meta():
    try:
        with open(META_FILE_PATH, "r") as f:
            meta = json.load(f)
        return meta if isinstance(meta, dict) else {}
    except (OSError, ValueError):
        return {}

def validate_config(wg_conf):
    if not wg_conf:
        raise ValueError("Configuration content is empty.")
    if not re.search(r'^\s*(?!#|;)\s*PrivateKey\s*=', wg_conf, re.IGNORECASE | re.MULTILINE):
        raise ValueError("Missing 'PrivateKey' property.")
    if not re.search(r'^\s*(?!#|;)\s*Address\s*=', wg_conf, re.IGNORECASE | re.MULTILINE):
        raise ValueError("Missing 'Address' property.")
    if not re.search(r'^\s*(?!#|;)\s*Endpoint\s*=', wg_conf, re.IGNORECASE | re.MULTILINE):
        raise ValueError("Missing 'Endpoint' routing property.")
    if not re.search(r'#\s*(?:VPNPort|Port Forwarding):\s*\d+', wg_conf, re.IGNORECASE):
        raise ValueError("Missing port-forwarding metadata (e.g., # Port Forwarding: XXXXX).")

TARGET_NODES = ("lnd", "cln", "eclair")

def save_configuration(conf_content, target_node="lnd", clear_pending_order=None, provisioned_key=None):
    """Saves a WireGuard configuration for target_node and resets the
    metadata for it. clear_pending_order (a payment hash) is set by the
    settlement watcher: when it still matches pendingOrder, the settled order
    and its private key are dropped in the same locked write, and its pay
    task is queued for clearing. provisioned_key (the public key the settled
    order was claimed for) is recorded as provisionedKey: TunnelSats issued
    that key, so _record_not_found gives it the long grace.

    The configuration is stored exactly as given: the node's clearnet-vpn
    task accepts this string verbatim, so rewriting it (e.g. stripping the
    markers earlier versions added) would re-raise that task. The one
    exception is the port marker, which apply_vpn_port keeps in line with
    the port TunnelSats reports.

    Every write happens under meta_lock, so a port rewrite never interleaves
    with a save. No caller holds meta_lock (flock is not reentrant)."""
    if target_node not in TARGET_NODES:
        target_node = "lnd"
    validate_config(conf_content)

    # The comment's expiry is a hint only; the confirmed expiry comes from
    # lazy_sync. Port and server stay as display hints.
    hints = parse_config_comments(conf_content)
    hints.pop("expiresAt", None)
    with meta_lock():
        atomic_write_file(CONFIG_PATH, conf_content)

        app_config = {}
        if os.path.exists(APP_CONFIG_PATH):
            try:
                with open(APP_CONFIG_PATH, "r") as f:
                    app_config = json.load(f)
            except Exception:
                pass
        app_config["enabled"] = True
        app_config["target-node"] = target_node
        app_config["tunnelsats-conf"] = conf_content
        atomic_write_json(APP_CONFIG_PATH, app_config)

        # The new configuration starts unconfirmed: everything bound to the
        # previous key or configuration goes. Fields owned by other writers
        # stay, above all pendingOrder, which holds the private key of an
        # order that may not be claimed yet.
        meta = read_meta()
        for stale in KEY_BOUND_META_FIELDS + ("publicKey", "syncError", "lastSyncAttempt",
                                              "serverDomain", "vpnPort", "provisionedKey"):
            meta.pop(stale, None)
        if provisioned_key:
            meta["provisionedKey"] = provisioned_key
        meta.update(hints)
        meta["lastSync"] = None
        meta["syncSuccess"] = False
        if clear_pending_order:
            _clear_pending(meta, "pendingOrder", clear_pending_order)
        atomic_write_json(META_FILE_PATH, meta)

def get_default_gateway():
    if hasattr(get_default_gateway, "_cache"):
        return get_default_gateway._cache
    try:
        with open("/proc/net/route", "r") as f:
            for line in f.read().splitlines()[1:]:
                parts = line.split()
                if len(parts) >= 3 and parts[1] == "00000000":
                    hex_gw = parts[2]
                    octets = [int(hex_gw[i:i+2], 16) for i in range(0, 8, 2)]
                    octets.reverse()
                    get_default_gateway._cache = ".".join(map(str, octets))
                    return get_default_gateway._cache
    except Exception:
        pass
    return None

def get_wg_pubkey():
    """Public key of the saved configuration, or "Unknown". `wg pubkey` only
    runs when the file changed (path, mtime, size, inode; saves replace the
    file, so the inode changes too): the sync loop checks the key every
    SYNC_POLL_STEP. Failed derivations are not cached and retry next call."""
    global _pubkey_cache
    try:
        st = os.stat(CONFIG_PATH)
    except OSError:
        return "Unknown"
    stamp = (CONFIG_PATH, st.st_mtime_ns, st.st_size, st.st_ino)
    cached = _pubkey_cache
    if cached and cached[0] == stamp:
        return cached[1]
    try:
        with open(CONFIG_PATH, 'r') as f:
            config_content = f.read()
        private_key_match = re.search(r'^\s*(?!#|;)\s*PrivateKey\s*=\s*(.+)', config_content, re.IGNORECASE | re.MULTILINE)
        if private_key_match:
            proc = subprocess.run(["wg", "pubkey"], input=private_key_match.group(1).strip().encode(), capture_output=True)
            pubkey = proc.stdout.decode().strip() if proc.returncode == 0 else ""
            if pubkey:
                # Read after the stat: a save in between only makes the next
                # call re-derive, never caches an old key under a new stamp.
                _pubkey_cache = (stamp, pubkey)
                return pubkey
    except Exception:
        pass
    return "Unknown"

def _superseded(wg_pubkey):
    """True when the saved configuration no longer holds the key a sync ran
    for. Its result must then be dropped: save_configuration has reset the
    metadata for the new key, and writing the old key's answer would restore
    a confirmation (or error) that belongs to a key no longer in use. Checked
    under meta_lock: save_configuration writes the configuration before it
    takes the lock for its reset, so either this check sees the new key or
    the save's reset lands after the write."""
    return get_wg_pubkey() != wg_pubkey

VPN_PORT_MARKER_RE = re.compile(r"(#\s*(?:VPNPort|Port Forwarding):\s*)(\d+)", re.IGNORECASE)

def valid_vpn_port(value):
    """The port as an int when it is a usable TCP port, else None. JSON
    booleans, strings and floats are rejected rather than coerced."""
    if type(value) is int and 1 <= value <= 65535:
        return value
    return None

def rewrite_vpn_port(conf, port):
    """conf with every port marker set to port, keeping each label and its
    spacing; everything else stays byte for byte. None when conf has no
    marker or every marker already holds port."""
    if not VPN_PORT_MARKER_RE.search(conf):
        return None
    rewritten = VPN_PORT_MARKER_RE.sub(lambda m: f"{m.group(1)}{port}", conf)
    return None if rewritten == conf else rewritten

def _file_stamp(path):
    """(mtime_ns, size, inode) of path. The TypeScript FileHelper rewrites
    files in place, which changes mtime; bridge.py replaces them, which
    changes the inode."""
    st = os.stat(path)
    return (st.st_mtime_ns, st.st_size, st.st_ino)

def _write_json_if_unchanged(filepath, data, stamp, mode=0o600):
    """atomic_write_json, but only while filepath still has `stamp`: the
    check runs after the temporary file is written, right before the
    rename, so a writer that does not take meta_lock can only slip into
    the stat-to-rename gap. Returns False (and writes nothing) when the file
    changed."""
    tmp_path = filepath + ".tmp"
    try:
        fd = os.open(tmp_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, mode)
        with os.fdopen(fd, 'w') as f:
            f.write(json.dumps(data, indent=2))
        try:
            unchanged = _file_stamp(filepath) == stamp
        except OSError:
            unchanged = False
        if not unchanged:
            os.remove(tmp_path)
            return False
        os.replace(tmp_path, filepath)
        try:
            os.chmod(filepath, mode)
        except Exception:
            pass
        return True
    except Exception:
        if os.path.exists(tmp_path):
            try:
                os.remove(tmp_path)
            except Exception:
                pass
        raise

def apply_vpn_port(port):
    """Brings the stored configuration's port marker in line with the port
    TunnelSats reports for the key, so the node's clearnet-vpn task is
    re-raised with the new announce address. Caller holds meta_lock and has
    checked the key is still current (_superseded).

    Inactive until the status endpoint returns vpn_port
    (tunnelsats-v2-web#308).

    Returns "unchanged", "updated", "conflict" (config.json holds another
    configuration: Configure/Import write first config.json, then the conf
    file, so that save was interrupted and the operator's newer configuration
    wins), "no-config" or "no-marker". Raises OSError when a write fails.

    config.json is written first: after an interruption it holds the
    rewritten configuration while the conf file does not, and the next call
    completes the rewrite. The reverse order would strand config.json.

    Configure and Import save under the same meta_lock (through
    `bridge.py meta-lock`, #94), so no save interleaves with this rewrite.
    config.json is still only replaced while its stamp matches the one taken
    before it was read (_write_json_if_unchanged), as a guard against a
    writer that bypasses the lock."""
    try:
        with open(CONFIG_PATH, "r") as f:
            stored = f.read()
    except OSError:
        return "no-config"
    rewritten = rewrite_vpn_port(stored, port)
    if rewritten is None:
        return "no-marker" if not VPN_PORT_MARKER_RE.search(stored) else "unchanged"
    try:
        # Stamp first: a write between stat and read only makes the replace
        # below refuse, never lets it overwrite newer content.
        stamp = _file_stamp(APP_CONFIG_PATH)
        with open(APP_CONFIG_PATH, "r") as f:
            app_config = json.load(f)
    except (OSError, ValueError):
        # Missing, or unreadable (e.g. a write that bypassed the lock).
        return "conflict"
    if not isinstance(app_config, dict):
        return "conflict"
    current = app_config.get("tunnelsats-conf")
    if current == stored:
        app_config["tunnelsats-conf"] = rewritten
        if not _write_json_if_unchanged(APP_CONFIG_PATH, app_config, stamp):
            return "conflict"
    elif current != rewritten:
        return "conflict"
    atomic_write_file(CONFIG_PATH, rewritten)
    return "updated"

def _bind_meta_to_key(meta, wg_pubkey):
    """A confirmation (or an unknown-key verdict) belongs to the key it was
    recorded for. A new key (e.g. a freshly imported config) starts
    unconfirmed."""
    if meta.get("publicKey") != wg_pubkey:
        for stale in KEY_BOUND_META_FIELDS:
            meta.pop(stale, None)
        meta["publicKey"] = wg_pubkey

def _confirmed_since(meta, wg_pubkey, since):
    """True when meta already holds a confirmation for wg_pubkey recorded at
    or after `since` (by a concurrent sync)."""
    if meta.get("publicKey") != wg_pubkey or meta.get("syncSuccess") is not True:
        return False
    try:
        last = datetime.fromisoformat(str(meta.get("lastSync")).replace("Z", "+00:00"))
    except ValueError:
        return False
    if last.tzinfo is None:
        last = last.replace(tzinfo=timezone.utc)
    return last >= since

class _KeyNotFound(Exception):
    """The status endpoint answered that it has no subscription for the key."""


def _is_not_found_answer(http_error):
    """True only for the status endpoint's own "no subscription for this key"
    answer: HTTP 404 with the ERR_RESOURCE_NOT_FOUND code. A 404 from a
    proxy, a CDN or a removed route carries no such body and stays an
    operational failure."""
    if http_error.code != 404:
        return False
    try:
        body = json.loads(http_error.read().decode("utf-8"))
    except Exception:
        return False
    return isinstance(body, dict) and body.get("error") == STATUS_NOT_FOUND_CODE


MAX_BANDWIDTH_LIMIT_GB = 1_000_000
MAX_RESET_COUNT = 1000


def valid_bandwidth_limit(value):
    """A monthly bandwidth limit in GB from the API: a finite number above 0
    (and below a sanity bound); None for anything else."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return value if math.isfinite(value) and 0 < value <= MAX_BANDWIDTH_LIMIT_GB else None


def valid_reset_count(value):
    """A count of bandwidth resets from the API: a whole number from 0 (and
    below a sanity bound); None for anything else."""
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    return value if 0 <= value <= MAX_RESET_COUNT else None


def lazy_sync(wg_pubkey, require_usage=False):
    """Refreshes the confirmed subscription state for wg_pubkey.

    Returns an explicit outcome: "confirmed" (API answered with a valid
    expiry), "unknown-key" (the API has no subscription for this key; see
    _record_not_found), "not-found" (the API answered "not found" for a key
    it confirmed before, not yet long enough to count as unknown), "failed"
    (operational failure: no answer about the key; the last confirmed value
    for this key is kept), "superseded" (the configured key changed while
    the request was in flight; nothing written) or "skipped" (no usable
    key)."""
    if not wg_pubkey or wg_pubkey == "Unknown" or wg_pubkey == "Not available":
        return "skipped"

    import urllib.request
    import urllib.error
    url = f"{TUNNELSATS_API_URL}/subscription/status"
    data = json.dumps({"wgPublicKey": wg_pubkey}).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        headers={
            "Content-Type": "application/json",
            "User-Agent": f"TunnelSats-StartOS/{get_package_version()}"
        },
        method="POST"
    )

    started_at = datetime.now(timezone.utc)
    try:
        response_data = None
        for attempt in range(5):
            try:
                with urllib.request.urlopen(req, timeout=10) as response:
                    response_data = json.loads(response.read().decode("utf-8"))
                    break
            except urllib.error.HTTPError as e:
                if _is_not_found_answer(e):
                    raise _KeyNotFound() from e
                if 400 <= e.code < 500:
                    raise e
                if attempt == 4:
                    raise e
                time.sleep(5)
            except Exception as e:
                if attempt == 4:
                    raise e
                time.sleep(5)

        if not isinstance(response_data, dict):
            raise ValueError("TunnelSats API returned an unexpected response")

        expiry = response_data.get("expiry")
        if not (expiry and is_valid_iso_expiry(expiry)):
            raise ValueError("TunnelSats API returned no valid expiry for this key")

        # The only writer of a confirmed expiry. Never the # Valid Until comment.
        fields = {"expiresAt": expiry, "expirySource": "api"}

        server_domain = response_data.get("server_domain")
        if server_domain:
            fields["serverDomain"] = server_domain

        # The status endpoint does not return vpn_port yet; the port
        # rewrite (apply_vpn_port) activates once tunnelsats-v2-web#308 ships.
        vpn_port = valid_vpn_port(response_data.get("vpn_port"))
        if vpn_port is not None:
            fields["vpnPort"] = vpn_port

        raw_usage = response_data.get("bandwidth_used_gb")
        if raw_usage is not None and not isinstance(raw_usage, bool):
            try:
                usage = float(raw_usage)
                if math.isfinite(usage) and usage >= 0:
                    fields["bandwidth_used_gb"] = usage
            except (ValueError, TypeError):
                pass
        if require_usage and "bandwidth_used_gb" not in fields:
            raise ValueError("TunnelSats API returned no valid bandwidth usage for this key")

        # The monthly quota. A confirmed answer without a valid value drops
        # the stored one: a stale limit or reset count is worse than none.
        # The same holds for usage: lastSync dates every stored field, so a
        # usage figure this answer did not confirm (possibly from last month)
        # must not stay behind looking current.
        quota = {
            "bandwidth_limit_gb": valid_bandwidth_limit(response_data.get("bandwidth_limit_gb")),
            "bandwidth_resets_this_month": valid_reset_count(response_data.get("bandwidth_resets_this_month")),
            "max_resets_per_month": valid_reset_count(response_data.get("max_resets_per_month")),
        }
        fields.update({name: value for name, value in quota.items() if value is not None})
        dropped_quota = [name for name, value in quota.items() if value is None]
        if "bandwidth_used_gb" not in fields:
            dropped_quota.append("bandwidth_used_gb")

        with meta_lock():
            if _superseded(wg_pubkey):
                print("Subscription sync result dropped: the configured key changed", file=sys.stderr)
                return "superseded"
            # Merge into a fresh read: the request can take a minute, and
            # other writers may have updated the file meanwhile.
            meta = read_meta()
            old_expiry = meta.get("expiresAt") if meta.get("publicKey") == wg_pubkey else None
            _bind_meta_to_key(meta, wg_pubkey)
            meta.update(fields)
            nwc_state = meta.get("nwcAutoRenewState")
            if isinstance(nwc_state, dict):
                period_exp = nwc_state.get("periodExpiry")
                if _nwc_period_advanced(period_exp or old_expiry, expiry):
                    nwc_state = dict(nwc_state)
                    nwc_state.update({
                        "periodExpiry": expiry,
                        "attempts": 0,
                        "nextAttemptAt": None,
                        "lastError": None,
                        "lastErrorCode": None,
                        "budgetWarning": False,
                        "fallbackTaskRaised": False,
                    })
                    meta["nwcAutoRenewState"] = nwc_state
            for name in dropped_quota:
                meta.pop(name, None)
            meta["lastSync"] = datetime.now(timezone.utc).isoformat()
            meta["syncSuccess"] = True
            meta["syncError"] = None
            meta.pop("keyUnknown", None)
            meta.pop("notFoundSince", None)
            atomic_write_json(META_FILE_PATH, meta)
            if vpn_port is not None:
                # Still under the lock and after the key check, so a save
                # cannot interleave. Driven by the stored file, not by meta:
                # a rewrite that failed here is retried on the next sync.
                try:
                    port_result = apply_vpn_port(vpn_port)
                except OSError as e:
                    port_result = "error"
                    print(f"Could not update the VPN port marker: {e}", file=sys.stderr)
                if port_result == "updated":
                    print(f"VPN port marker updated to {vpn_port}; the node's clearnet VPN task is raised again", file=sys.stderr)
                elif port_result == "conflict":
                    print("VPN port marker not updated: the configuration is being replaced", file=sys.stderr)
                elif port_result in ("no-config", "no-marker"):
                    print(f"VPN port marker not updated ({port_result})", file=sys.stderr)
        return "confirmed"

    except _KeyNotFound:
        return _record_not_found(wg_pubkey, started_at)

    except Exception as e:
        # Keep the last confirmed value for this key; never extend it and
        # never substitute the comment. An unknown-key verdict stays too: a
        # failure says nothing new about the key.
        err_msg = str(e)
        print(f"Error during lazy subscription sync: {err_msg}", file=sys.stderr)
        try:
            with meta_lock():
                if _superseded(wg_pubkey):
                    return "superseded"
                meta = read_meta()
                if _confirmed_since(meta, wg_pubkey, started_at):
                    # A concurrent sync (health check, forced sync) confirmed
                    # this key after this attempt started; its answer is newer.
                    print("Subscription sync failure not recorded: a concurrent sync confirmed this key", file=sys.stderr)
                    return "failed"
                _bind_meta_to_key(meta, wg_pubkey)
                if meta.get("keyUnknown") is not True:
                    # A failure breaks a run of not-found answers: the grace
                    # period must be covered by answers, not by silence.
                    meta.pop("notFoundSince", None)
                meta["syncSuccess"] = False
                meta["syncError"] = err_msg
                meta["lastSyncAttempt"] = datetime.now(timezone.utc).isoformat()
                atomic_write_json(META_FILE_PATH, meta)
        except Exception as write_error:
            print(f"Could not record the subscription sync failure: {write_error}", file=sys.stderr)
        return "failed"


def _record_not_found(wg_pubkey, started_at):
    """Records the API's "no subscription for this key" answer.

    `notFoundSince` marks the first answer of an unbroken run of them: a
    confirmation or an operational failure ends the run. The endpoint also
    answers 404 while one of its servers is unreachable (tunnelsats-v2-web#309
    changes that to a 503), so a key is declared unknown only once the run
    has lasted NEW_KEY_UNKNOWN_AFTER (a key the API never confirmed, e.g. an
    import) or UNKNOWN_KEY_CONFIRM_AFTER (a key it confirmed before, whose
    confirmed expiry is kept until then, or the key of a settled purchase). Declaring drops the confirmation: the API's
    latest definitive answer is that the key has no subscription."""
    try:
        with meta_lock():
            if _superseded(wg_pubkey):
                return "superseded"
            meta = read_meta()
            if _confirmed_since(meta, wg_pubkey, started_at):
                print("Subscription not-found answer not recorded: a concurrent sync confirmed this key",
                      file=sys.stderr)
                return "not-found"
            _bind_meta_to_key(meta, wg_pubkey)
            now = datetime.now(timezone.utc)
            since = _parse_iso(meta.get("notFoundSince")) or now
            known_to_exist = (meta.get("expirySource") == "api"
                              or meta.get("provisionedKey") == wg_pubkey)
            grace = UNKNOWN_KEY_CONFIRM_AFTER if known_to_exist else NEW_KEY_UNKNOWN_AFTER
            declared = meta.get("keyUnknown") is True or now - since >= grace
            meta["notFoundSince"] = _iso(since)
            meta["lastSyncAttempt"] = now.isoformat()
            if declared:
                for field in CONFIRMED_META_FIELDS:
                    meta.pop(field, None)
                meta["keyUnknown"] = True
                meta["syncError"] = UNKNOWN_KEY_MESSAGE
            else:
                meta["syncError"] = NOT_FOUND_PENDING_MESSAGE
            meta["syncSuccess"] = False
            atomic_write_json(META_FILE_PATH, meta)
    except Exception as write_error:
        print(f"Could not record the subscription not-found answer: {write_error}", file=sys.stderr)
        return "failed"
    if declared:
        print("TunnelSats has no subscription for the configured key", file=sys.stderr)
        return "unknown-key"
    print(f"TunnelSats did not find the configured key (since {_iso(since)}); checking again", file=sys.stderr)
    return "not-found"

SYNC_POLL_STEP = 30

def vpn_port_pending(wg_pubkey):
    """True while the API confirmed a forwarded port for wg_pubkey that the
    stored conf file's marker does not hold yet: apply_vpn_port conflicted,
    failed or was interrupted. Only a port from a confirmed sync counts
    (save_configuration's marker hint equals the marker by definition)."""
    meta = read_meta()
    if meta.get("publicKey") != wg_pubkey or meta.get("expirySource") != "api":
        return False
    port = valid_vpn_port(meta.get("vpnPort"))
    if port is None:
        return False
    try:
        with open(CONFIG_PATH, "r") as f:
            stored = f.read()
    except OSError:
        return False
    return rewrite_vpn_port(stored, port) is not None

def sync_wait_outcome(outcome, wg_pubkey):
    """The outcome the background loop waits on: a confirmation whose port
    rewrite did not land is retried after minutes, not after a day, since
    the node announces the old port meanwhile."""
    if outcome == "confirmed" and vpn_port_pending(wg_pubkey):
        return "port-pending"
    return outcome

def next_sync_delay(outcome):
    """Seconds until the next background sync. Only a confirmation earns
    the long wait; a superseded sync re-runs almost at once for the new key.
    A not-found answer is checked again after 15 minutes (at least
    NEW_KEY_UNKNOWN_AFTER, see _record_not_found); a declared unknown key
    hourly, so it is not polled every few minutes."""
    if outcome == "confirmed":
        return 86400
    if outcome == "superseded":
        return 5
    if outcome == "port-pending":
        return 300
    if outcome == "not-found":
        return 900
    if outcome == "unknown-key":
        return 3600
    return 300

def wait_for_next_sync(outcome, synced_key, sleep=time.sleep, current_key=None):
    """Waits next_sync_delay(outcome) in SYNC_POLL_STEP slices and ends
    early when the configured key changes, so a newly saved configuration is
    confirmed within a poll step instead of after the long wait. Returns
    "key-changed" or "elapsed"."""
    current_key = current_key or get_wg_pubkey
    remaining = next_sync_delay(outcome)
    while remaining > 0:
        step = min(SYNC_POLL_STEP, remaining)
        sleep(step)
        remaining -= step
        if current_key() != synced_key:
            return "key-changed"
    return "elapsed"

def subscription_sync_loop():
    try:
        time.sleep(5)
    except KeyboardInterrupt:
        return
    while True:
        outcome = "skipped"
        pubkey = None
        try:
            pubkey = get_wg_pubkey()
            outcome = sync_wait_outcome(lazy_sync(pubkey), pubkey)
            if is_enabled() and pubkey and pubkey not in ("Unknown", "Not available"):
                try:
                    maybe_nwc_auto_renew(pubkey)
                except Exception as nwc_err:
                    print(f"Error during NWC auto-renewal check: {nwc_err}", file=sys.stderr)
        except Exception as e:
            print(f"Error in subscription sync loop: {e}", file=sys.stderr)
            outcome = "failed"

        try:
            wait_for_next_sync(outcome, pubkey)
        except KeyboardInterrupt:
            break

# ─── Settlement watcher ──────────────────────────────────────────────────────
# A Buy action leaves `pendingOrder` (with the private key generated on this
# server) in the metadata, a Renew action `pendingRenewal`, a Reset Bandwidth
# action `pendingReset`. settle_pending()
# finishes them once paid, so no step outside StartOS is needed. It runs as a
# StartOS health check (see startos/settlement.ts) every 20 s.
#
# Trust boundary: the claim response is only a source of tunnel parameters.
# The config is assembled here with the local private key; `fullConfig`,
# `config` and `peer.privateKey` are never read, and every field that ends up
# in the config is validated so a response cannot inject extra lines (wg-quick
# would run a `PostUp`). Anything incomplete or unexpected fails closed: the
# pending order and its key stay, and the tick retries after a delay.

PENDING_KINDS = (("order", "pendingOrder"), ("renewal", "pendingRenewal"), ("reset", "pendingReset"))
KIND_BY_KEY = {key: kind for kind, key in PENDING_KINDS}
# Replay IDs of the Pay Invoice tasks the Buy/Renew/Reset actions raise on the
# node. Must match payTaskReplayId() in startos/settlement.ts (see pay_task_replay_id).
PAY_TASK_REPLAY_PREFIX = {"order": "tunnelsats-order", "renewal": "tunnelsats-renewal",
                          "reset": "tunnelsats-reset"}
# Lightning invoices from TunnelSats expire after an hour; a day without
# payment means the pending state can go.
PENDING_TTL = timedelta(hours=24)
SETTLE_RETRY_DELAY = timedelta(minutes=5)
DEFAULT_ALLOWED_IPS = "0.0.0.0/0, ::/0"
_WG_KEY_RE = re.compile(r"^[A-Za-z0-9+/]{43}=$")
_HOSTNAME_RE = re.compile(
    r"^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?"
    r"(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$"
)


class SettlementError(Exception):
    """This tick could not finish the payment. Recorded on the pending entry
    (lastError) and retried after SETTLE_RETRY_DELAY; never clears it."""


class _ApiHttpError(SettlementError):
    def __init__(self, code, message):
        super().__init__(f"HTTP {code} from the TunnelSats API: {message}")
        self.code = code


def pay_task_replay_id(kind, node, payment_hash):
    """Unique per payment, so clearing a settled payment's task can never
    remove the task of a newer Buy/Renew on the same node."""
    return f"{PAY_TASK_REPLAY_PREFIX[kind]}:{node}:{payment_hash[:16]}"


def _iso(dt):
    return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _parse_iso(value):
    if not isinstance(value, str):
        return None
    try:
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


@contextmanager
def settle_lock():
    """Non-blocking: yields False while another tick (health check, CLI) is
    running, so two ticks never claim or save the same payment at once."""
    fd = os.open(META_FILE_PATH + ".settle.lock", os.O_RDWR | os.O_CREAT, 0o600)
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            acquired = True
        except BlockingIOError:
            acquired = False
        yield acquired
    finally:
        os.close(fd)


def _api_call(method, path, body=None):
    """Returns (http_status, json_object). HTTP errors raise _ApiHttpError,
    network and parse errors SettlementError. Response bodies are never
    logged: a claim response may carry key material."""
    req = urllib.request.Request(
        f"{TUNNELSATS_API_URL}{path}",
        data=json.dumps(body).encode("utf-8") if body is not None else None,
        headers={
            "Content-Type": "application/json",
            "User-Agent": f"TunnelSats-StartOS/{get_package_version()}",
        },
        method=method,
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as response:
            status = response.status
            payload = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        message = ""
        try:
            err = json.loads(e.read().decode("utf-8"))
            message = str(err.get("message") or err.get("error") or "")
        except Exception:
            pass
        raise _ApiHttpError(e.code, message[:200] or str(e.reason))
    except (OSError, ValueError) as e:
        raise SettlementError(f"TunnelSats API request failed: {e}")
    if not isinstance(payload, dict):
        raise SettlementError("TunnelSats API returned an unexpected response")
    return status, payload


def _payment_state(payment_hash):
    """'paid', 'processing', 'unpaid' or 'unknown' (the API has no record)."""
    try:
        status, data = _api_call("GET", f"/subscription/{payment_hash}")
    except _ApiHttpError as e:
        if e.code == 404:
            return "unknown"
        raise
    state = data.get("status")
    if status == 202 or state == "processing":
        return "processing"
    if state == "paid":
        return "paid"
    if state in ("unpaid", "pending"):
        return "unpaid"
    raise SettlementError(f"TunnelSats API returned an unknown payment status: {str(state)[:40]!r}")


def derive_wg_pubkey(private_key):
    """Public key for a WireGuard private key, or None."""
    try:
        proc = subprocess.run(["wg", "pubkey"], input=private_key.encode(), capture_output=True)
        pub = proc.stdout.decode().strip() if proc.returncode == 0 else ""
        if pub:
            return pub
    except Exception:
        pass
    try:
        import base64
        from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey
        from cryptography.hazmat.primitives import serialization
        key = X25519PrivateKey.from_private_bytes(base64.b64decode(private_key, validate=True))
        raw = key.public_key().public_bytes(encoding=serialization.Encoding.Raw,
                                            format=serialization.PublicFormat.Raw)
        return base64.b64encode(raw).decode()
    except Exception:
        return None


def _require_key(value, label):
    if not isinstance(value, str) or not _WG_KEY_RE.match(value):
        raise SettlementError(f"The claim has no valid {label}")
    return value


def _require_endpoint(value):
    if isinstance(value, str) and value.count(":") == 1:
        host, _, port = value.partition(":")
        if _HOSTNAME_RE.match(host) and port.isdigit() and 1 <= int(port) <= 65535:
            return value
    raise SettlementError("The claim has no valid endpoint")


def _require_address(value):
    try:
        if isinstance(value, str) and value == value.strip():
            ipaddress.ip_interface(value)
            return value
    except ValueError:
        pass
    raise SettlementError("The claim has no valid address")


def _require_allowed_ips(value):
    if value is None:
        return DEFAULT_ALLOWED_IPS
    try:
        if isinstance(value, str):
            networks = [part.strip() for part in value.split(",")]
            for network in networks:
                ipaddress.ip_network(network, strict=False)
            return ", ".join(networks)
    except ValueError:
        pass
    raise SettlementError("The claim has no valid allowedIPs")


def assemble_claimed_config(claim, pending):
    """Builds the WireGuard config for a claimed order from the claim's
    structured fields and the order's local private key. Raises
    SettlementError instead of returning anything unverified."""
    peer = claim.get("peer") if isinstance(claim.get("peer"), dict) else {}
    server = claim.get("server") if isinstance(claim.get("server"), dict) else {}
    private_key, public_key = pending.get("privateKey"), pending.get("publicKey")

    if peer.get("publicKey") != public_key:
        raise SettlementError(
            "The claim was provisioned for a different WireGuard key than the one "
            "generated on this server; not saving it"
        )
    if not isinstance(private_key, str) or derive_wg_pubkey(private_key) != public_key:
        raise SettlementError("The stored private key does not match the registered public key")

    server_key = _require_key(server.get("publicKey"), "server publicKey")
    endpoint = _require_endpoint(server.get("endpoint"))
    address = _require_address(peer.get("address"))
    allowed_ips = _require_allowed_ips(server.get("allowedIPs"))
    psk = peer.get("presharedKey")
    if psk is not None:
        _require_key(psk, "presharedKey")
    vpn_port = claim.get("vpnPort")
    if type(vpn_port) is not int or not 1 <= vpn_port <= 65535:
        raise SettlementError("The claim has no valid vpnPort")

    lines = [
        "[Interface]",
        f"PrivateKey = {private_key}",
        f"Address = {address}",
        f"# Server: {endpoint.partition(':')[0]}",
        f"# Port Forwarding: {vpn_port}",
        f"# myPubKey: {public_key}",
    ]
    end = claim.get("subscriptionEnd")
    if isinstance(end, str) and is_valid_iso_expiry(end):
        # A display hint only; the confirmed expiry always comes from lazy_sync.
        lines.append(f"# Valid Until: {_iso(_parse_iso(end))}")
    lines += ["", "[Peer]", f"PublicKey = {server_key}"]
    if psk is not None:
        lines.append(f"PresharedKey = {psk}")
    lines += [f"Endpoint = {endpoint}", f"AllowedIPs = {allowed_ips}", "PersistentKeepalive = 25"]
    return "\n".join(lines) + "\n"


def _clear_pending(meta, key, payment_hash, confirmed_expiry=None):
    """Drops meta[key] if it still belongs to payment_hash and queues its pay
    task for clearing. Caller holds meta_lock and writes meta afterwards."""
    pending = meta.get(key)
    if not isinstance(pending, dict) or pending.get("paymentHash") != payment_hash:
        return False
    kind = KIND_BY_KEY[key]
    node = pending.get("targetNode")
    meta.pop(key, None)
    if node in TARGET_NODES:
        tasks = [t for t in meta.get("payTasksToClear") or [] if isinstance(t, str)]
        replay_id = pay_task_replay_id(kind, node, payment_hash)
        if replay_id not in tasks:
            tasks.append(replay_id)
        meta["payTasksToClear"] = tasks
    if key == "pendingRenewal" and confirmed_expiry is not None:
        nwc_state = dict(meta.get("nwcAutoRenewState")) if isinstance(meta.get("nwcAutoRenewState"), dict) else {}
        if pending.get("paidViaNwc") is True or nwc_state.get("lastPaidHash") == payment_hash:
            raw_dur = pending.get("duration") or nwc_state.get("lastPaidDuration")
            dur_str = _dashboard_duration(raw_dur) or "1m"
            dur_months = int(dur_str[:-1])
            amt = pending.get("amountSats")
            if isinstance(amt, bool) or not isinstance(amt, (int, float)):
                amt = _bolt11_amount_sats(pending.get("invoice")) if isinstance(pending.get("invoice"), str) else None
            nwc_state.update({
                "attempts": 0,
                "nextAttemptAt": None,
                "lastError": None,
                "lastErrorCode": None,
                "budgetWarning": False,
                "fallbackTaskRaised": False,
                "lastPaidHash": payment_hash,
                "lastPaidAt": nwc_state.get("lastPaidAt") or _iso(datetime.now(timezone.utc)),
                "lastPaidDuration": dur_months,
                "lastPaidAmountSats": amt,
                "lastPaidNewExpiry": confirmed_expiry,
            })
            meta["nwcAutoRenewState"] = nwc_state
        elif nwc_state:
            nwc_state.update({
                "attempts": 0,
                "nextAttemptAt": None,
                "lastError": None,
                "lastErrorCode": None,
                "budgetWarning": False,
                "fallbackTaskRaised": False,
            })
            meta["nwcAutoRenewState"] = nwc_state
    return True


def _finish_pending(key, payment_hash, confirmed_expiry=None):
    with meta_lock():
        meta = read_meta()
        if _clear_pending(meta, key, payment_hash, confirmed_expiry=confirmed_expiry):
            atomic_write_json(META_FILE_PATH, meta)


def _update_pending(key, payment_hash, fields):
    """Sets (value) or removes (None) fields on meta[key] if it still belongs
    to payment_hash; a newer Buy/Renew is never touched."""
    with meta_lock():
        meta = read_meta()
        pending = meta.get(key)
        if not isinstance(pending, dict) or pending.get("paymentHash") != payment_hash:
            return
        for name, value in fields.items():
            if value is None:
                pending.pop(name, None)
            else:
                pending[name] = value
        atomic_write_json(META_FILE_PATH, meta)


def _outcome(kind, result, message, payment_hash):
    return {"kind": kind, "result": result, "message": message, "paymentHash": payment_hash}


def _unpaid(kind, key, pending, state, now):
    created = _parse_iso(pending.get("createdAt"))
    if created is not None and now - created >= PENDING_TTL:
        _finish_pending(key, pending["paymentHash"])
        return _outcome(kind, "expired", "The invoice was not paid within 24 hours; the pending payment was cleared.",
                        pending["paymentHash"])
    if state == "unknown":
        raise SettlementError("The TunnelSats API has no record of this payment")
    return _outcome(kind, "waiting", "Waiting for the invoice to be paid.", pending["paymentHash"])


def _mark_payment_received(key, pending, payment_hash):
    """Records that payment_hash was paid or is processing. Keyed by
    payment_hash so a replacement Buy/Renew/Reset that deep-merges over
    meta[key] without clearing extra keys never inherits the old payment's
    received state."""
    if pending.get("paymentReceivedFor") != payment_hash:
        pending["paymentReceivedFor"] = payment_hash
        _update_pending(key, payment_hash, {"paymentReceivedFor": payment_hash})


def _settle_order(pending, now):
    payment_hash = pending["paymentHash"]
    state = _payment_state(payment_hash)
    if state in ("processing", "paid"):
        _mark_payment_received("pendingOrder", pending, payment_hash)
    if state == "processing":
        return _outcome("order", "waiting", "Payment received; the tunnel is being provisioned.", payment_hash)
    if state != "paid":
        return _unpaid("order", "pendingOrder", pending, state, now)

    status, claim = _api_call("POST", "/subscription/claim",
                              {"paymentHash": payment_hash, "wgPublicKey": pending.get("publicKey")})
    if status == 202 or claim.get("status") == "processing":
        return _outcome("order", "waiting", "Payment received; the tunnel is being provisioned.", payment_hash)
    conf = assemble_claimed_config(claim, pending)
    # Applied even if a newer Buy replaced pendingOrder meanwhile: this order
    # is paid and its private key exists only in this tick, while the newer
    # one is at best unpaid. Skipping it would lose a paid tunnel for good.
    # save_configuration's hash check keeps the newer pendingOrder, which
    # the next tick settles (and applies) once it is paid.
    save_configuration(conf, pending.get("targetNode"), clear_pending_order=payment_hash,
                       provisioned_key=pending.get("publicKey"))
    return _outcome("order", "provisioned", "The new tunnel was configured.", payment_hash)


def _settle_renewal(pending, now):
    payment_hash = pending["paymentHash"]
    state = _payment_state(payment_hash)
    if state in ("processing", "paid"):
        _mark_payment_received("pendingRenewal", pending, payment_hash)
    if state == "processing":
        return _outcome("renewal", "waiting", "Payment received; the renewal is being applied.", payment_hash)
    if state != "paid":
        return _unpaid("renewal", "pendingRenewal", pending, state, now)

    key = pending.get("publicKey")
    if not key:
        # Recorded by an earlier version without the key it was paid for.
        # The configured key's expiry proves nothing about it, so it is
        # released rather than reported as renewed.
        _finish_pending("pendingRenewal", payment_hash)
        return _outcome("renewal", "superseded",
                        "A renewal from an earlier version was paid; TunnelSats applies it to the key it was "
                        "bought for. Check the expiry under Subscription Status.", payment_hash)
    if key != get_wg_pubkey():
        _finish_pending("pendingRenewal", payment_hash)
        return _outcome("renewal", "superseded",
                        "The renewal was paid for a key that is no longer configured.", payment_hash)

    result = lazy_sync(key)
    if result == "confirmed":
        confirmed = _parse_iso(read_meta().get("expiresAt"))
        old = _parse_iso(pending.get("oldExpiry"))
        if confirmed is not None and (old is None or confirmed > old):
            _finish_pending("pendingRenewal", payment_hash, confirmed_expiry=_iso(confirmed))
            return _outcome("renewal", "renewed", "The subscription was extended.", payment_hash)
        return _outcome("renewal", "waiting", "Renewal paid; waiting for the extended expiry to be confirmed.",
                        payment_hash)
    if result == "superseded":
        return _outcome("renewal", "waiting", "The configured key changed; checking again.", payment_hash)
    raise SettlementError("The renewal is paid, but its new expiry could not be confirmed yet")


RESET_STATES = ("unpaid", "processing", "paid", "failed", "expired")


def _reset_state(payment_hash):
    """The typed state of a bandwidth-reset payment, or 'unknown' (404).
    Only an answer typed `bandwidth_reset` counts: an untyped `paid` is the
    order fallback of a backend that does not know resets, and it says
    nothing about whether the reset was applied."""
    try:
        status, data = _api_call("GET", f"/subscription/{payment_hash}")
    except _ApiHttpError as e:
        if e.code == 404:
            return "unknown"
        raise
    if data.get("type") != "bandwidth_reset":
        raise SettlementError("The TunnelSats API does not confirm bandwidth resets yet; retrying")
    state = "processing" if status == 202 else data.get("status")
    if state not in RESET_STATES:
        raise SettlementError(f"TunnelSats API returned an unknown reset status: {str(state)[:40]!r}")
    return state


def _settle_reset(pending, now):
    payment_hash = pending["paymentHash"]
    state = _reset_state(payment_hash)
    created = _parse_iso(pending.get("createdAt"))
    stale = created is not None and now - created >= PENDING_TTL

    if state in ("processing", "paid", "failed"):
        _mark_payment_received("pendingReset", pending, payment_hash)
    if state == "processing":
        return _outcome("reset", "waiting", "Payment received; the bandwidth reset is being applied.", payment_hash)
    if state in ("unpaid", "unknown"):
        # The invoice cannot be paid after it expires; without a recorded
        # expiry, the same day-long limit as Buy/Renew applies.
        expires = _parse_iso(pending.get("expiresAt"))
        if (expires is not None and now >= expires) or stale:
            _finish_pending("pendingReset", payment_hash)
            return _outcome("reset", "expired", "The bandwidth reset invoice expired unpaid; it was cleared.",
                            payment_hash)
        if state == "unknown":
            raise SettlementError("The TunnelSats API has no record of this bandwidth reset")
        return _outcome("reset", "waiting", "Waiting for the bandwidth reset invoice to be paid.", payment_hash)
    if state == "expired":
        _finish_pending("pendingReset", payment_hash)
        return _outcome("reset", "expired", "The bandwidth reset invoice expired unpaid; it was cleared.",
                        payment_hash)
    if state == "failed":
        raise SettlementError(
            f"The payment was received, but the bandwidth reset failed. Contact TunnelSats support "
            f"with payment hash {payment_hash}."
        )

    # paid: applied server-side to the key it was bought for.
    key = pending.get("publicKey")
    if not key or key != get_wg_pubkey():
        _finish_pending("pendingReset", payment_hash)
        return _outcome("reset", "superseded",
                        "The bandwidth reset was applied to a key that is no longer configured.", payment_hash)
    result = lazy_sync(key, require_usage=True)
    if result == "confirmed":
        _finish_pending("pendingReset", payment_hash)
        return _outcome("reset", "reset", "The bandwidth reset was applied.", payment_hash)
    if result == "superseded":
        return _outcome("reset", "waiting", "The configured key changed; checking again.", payment_hash)
    raise SettlementError("The bandwidth reset was applied, but the refreshed usage could not be confirmed yet")


_SETTLERS = {"order": _settle_order, "renewal": _settle_renewal, "reset": _settle_reset}


def _settle_one(kind, key, pending, now):
    payment_hash = pending["paymentHash"]
    retry_at = _parse_iso(pending.get("nextAttemptAt"))
    if retry_at is not None and retry_at > now:
        return _outcome(kind, "failed", str(pending.get("lastError") or "Retrying shortly."), payment_hash)
    try:
        outcome = _SETTLERS[kind](pending, now)
    except Exception as e:
        # SettlementError is an expected, explained failure; anything else is
        # a bug or an I/O error. Both keep the pending entry and retry later.
        message = str(e) if isinstance(e, SettlementError) else f"Unexpected error: {e}"
        print(f"Settlement of {kind} {payment_hash[:8]} failed: {message}", file=sys.stderr)
        _update_pending(key, payment_hash, {"lastError": message,
                                            "nextAttemptAt": _iso(now + SETTLE_RETRY_DELAY)})
        return _outcome(kind, "failed", message, payment_hash)
    if outcome["result"] == "waiting":
        stale_fields = {}
        if "lastError" in pending or "nextAttemptAt" in pending:
            stale_fields["lastError"] = None
            stale_fields["nextAttemptAt"] = None
        if "paymentReceivedFor" in pending and pending.get("paymentReceivedFor") != payment_hash:
            stale_fields["paymentReceivedFor"] = None
        if stale_fields:
            _update_pending(key, payment_hash, stale_fields)
    return outcome


def _pay_tasks_to_clear(meta):
    return [t for t in meta.get("payTasksToClear") or [] if isinstance(t, str)]


def settle_pending(now=None):
    """One settlement tick. Returns {"outcomes": [...], "clearPayTasks": [...],
    "busy": bool}. Each outcome's result is one of "waiting", "provisioned",
    "renewed", "reset", "superseded", "expired" or "failed". clearPayTasks lists the
    replay IDs of pay tasks whose payment is settled or expired; they stay
    listed until acknowledged with ack_pay_tasks, so a restart between
    settling and clearing the task cannot leave the task behind. The IDs are
    unique per payment, so clearing them never touches a newer payment's
    task."""
    now = now or datetime.now(timezone.utc)
    with settle_lock() as acquired:
        if not acquired:
            return {"outcomes": [], "clearPayTasks": [], "busy": True}
        with meta_lock():
            meta = read_meta()
        outcomes = []
        for kind, key in PENDING_KINDS:
            pending = meta.get(key)
            if isinstance(pending, dict) and isinstance(pending.get("paymentHash"), str) and pending["paymentHash"]:
                outcomes.append(_settle_one(kind, key, pending, now))
        with meta_lock():
            tasks = _pay_tasks_to_clear(read_meta())
        return {"outcomes": outcomes, "clearPayTasks": tasks, "busy": False}


def ack_pay_tasks(replay_ids):
    """Removes replay IDs whose pay tasks were cleared from payTasksToClear."""
    with meta_lock():
        meta = read_meta()
        if "payTasksToClear" not in meta:
            return
        remaining = [t for t in _pay_tasks_to_clear(meta) if t not in replay_ids]
        if remaining:
            meta["payTasksToClear"] = remaining
        else:
            meta.pop("payTasksToClear", None)
        atomic_write_json(META_FILE_PATH, meta)

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

_package_version_cache = None

def get_package_version():
    global _package_version_cache
    if _package_version_cache is not None:
        return _package_version_cache

    env_ver = os.environ.get("PACKAGE_VERSION")
    if env_ver:
        _package_version_cache = env_ver.partition(':')[0]
        return _package_version_cache

    vpath = os.path.join(os.path.dirname(__file__), "version.json")
    if os.path.exists(vpath):
        try:
            with open(vpath, "r") as f:
                data = json.load(f)
                ver = data.get("semver") or data.get("version")
                if ver:
                    _package_version_cache = ver.partition(':')[0]
                    return _package_version_cache
        except Exception:
            pass

    _package_version_cache = "0.4.0"
    return _package_version_cache

DASHBOARD_CSP = (
    "default-src 'self'; "
    "script-src 'self'; "
    "style-src 'self'; "
    "img-src 'self' data:; "
    "connect-src 'self'; "
    "font-src 'self'; "
    "object-src 'none'; "
    "base-uri 'none'; "
    "form-action 'none'"
)


class DashboardHTTPRequestHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass

    def end_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Security-Policy", DASHBOARD_CSP)
        self.send_header("Referrer-Policy", "no-referrer")
        super().end_headers()

    def is_trusted_request(self):
        client_ip = self.client_address[0]
        if client_ip.startswith("::ffff:"):
            client_ip = client_ip[7:]
        is_local = client_ip in ("127.0.0.1", "::1", "localhost")

        gateway_ip = get_default_gateway()
        embassy_ip = None
        try:
            import socket
            embassy_ip = socket.gethostbyname("embassy")
        except Exception:
            pass

        is_trusted_proxy = (
            (gateway_ip and client_ip == gateway_ip) or
            (embassy_ip and client_ip == embassy_ip)
        )

        if not is_local and not is_trusted_proxy:
            self.send_error(403, "Access denied")
            return False

        host_header = self.headers.get("Host", "").lower()
        if host_header.startswith('['):
            host_name = host_header.partition(']')[0] + ']'
        else:
            host_name = host_header.partition(':')[0]

        if is_local:
            is_allowed_host = host_name in ("localhost", "127.0.0.1", "[::1]")
        else:
            allowed_suffixes = (".local", ".lan", ".onion")
            is_allowed_host = any(host_name.endswith(suffix) for suffix in allowed_suffixes)
            if not is_allowed_host:
                ip_str = host_name
                if ip_str.startswith('[') and ip_str.endswith(']'):
                    ip_str = ip_str[1:-1]
                import ipaddress
                try:
                    is_allowed_host = ipaddress.ip_address(ip_str).is_private
                except ValueError:
                    pass

        if not is_allowed_host:
            self.send_error(403, "Access denied")
            return False

        # Validate Origin header if present
        origin = self.headers.get("Origin")
        if origin:
            try:
                origin_host = origin.split("://")[-1].split("/")[0].split(":")[0].lower()
                is_allowed_origin = (
                    origin_host in ("localhost", "127.0.0.1", "[::1]") or
                    any(origin_host.endswith(s) for s in (".local", ".lan", ".onion"))
                )
                if not is_allowed_origin:
                    import ipaddress
                    try:
                        is_allowed_origin = ipaddress.ip_address(origin_host).is_private
                    except ValueError:
                        is_allowed_origin = False

                if not is_allowed_origin:
                    self.send_error(403, "Cross-origin request rejected")
                    return False
            except Exception:
                self.send_error(403, "Invalid Origin header")
                return False

        # CSRF and content-type enforcement for POST
        if getattr(self, "command", "GET") == "POST":
            content_type = self.headers.get("Content-Type", "").split(";")[0].strip().lower()
            if content_type != "application/json":
                self.send_error(415, "Unsupported Media Type: application/json required")
                return False

            csrf_token = self.headers.get("X-CSRF-Token") or self.headers.get("X-TunnelSats-CSRF")
            if not validate_csrf_token(csrf_token):
                self.send_error(403, "Invalid or missing CSRF token")
                return False

            fetch_site = self.headers.get("Sec-Fetch-Site", "").lower()
            if fetch_site == "cross-site":
                self.send_error(403, "Cross-site request rejected")
                return False

        return True

    def do_GET(self):
        if not self.is_trusted_request():
            return

        path_only = self.path.partition('?')[0].partition('#')[0]
        if path_only == "/api/status":
            from urllib.parse import urlparse, parse_qs
            query_params = parse_qs(urlparse(self.path).query)
            force_sync = query_params.get("force", ["0"])[0] in ("1", "true", "yes")

            if force_sync:
                pubkey = get_wg_pubkey()
                if pubkey and pubkey not in ("Unknown", "Not available"):
                    try:
                        lazy_sync(pubkey)
                    except Exception as e:
                        print(f"Force sync failed: {e}", file=sys.stderr)

            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()

            status_data = get_status()
            target_host, target_port = get_target_details()

            response = {
                "version": status_data.get("version", get_package_version()),
                "enabled": status_data.get("enabled", is_enabled()),
                "configured": status_data.get("configured", False),
                "allow_ipv6": status_data.get("allow_ipv6", is_allow_ipv6()),
                "status": status_data.get("status", "stopped"),
                "subscription_active": status_data.get("subscription_active", False),
                "subscription_linked": status_data.get("subscription_linked", False),
                "pubkey": status_data.get("pubkey", get_wg_pubkey()),
                "expires_at": status_data.get("expires_at", "Unknown"),
                "days_remaining": status_data.get("days_remaining"),
                "expiry_formatted": status_data.get("expiry_formatted", "Unknown"),
                "target_host": target_host,
                "target_port": target_port,
                "vpn_port": status_data.get("vpn_port", DEFAULT_VPN_PORT),
                "public_ip": status_data.get("public_ip", "Unknown"),
                "server": status_data.get("server", "Unknown"),
                "vpn_ip": status_data.get("vpn_ip", "None"),
                "internal_octet": status_data.get("internal_octet", "Unknown"),
                "last_sync": status_data.get("last_sync"),
                "bandwidth_used_gb": status_data.get("bandwidth_used_gb", 0.0),
                "bandwidth_limit_gb": status_data.get("bandwidth_limit_gb", BANDWIDTH_LIMIT_GB),
                "csrf_token": get_csrf_token(),
            }
            self.wfile.write(json.dumps(response).encode("utf-8"))
            return

        if path_only == "/api/csrf":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"csrf_token": get_csrf_token()}).encode("utf-8"))
            return

        if path_only == "/api/servers":
            # Outbound, but cached (see get_servers).
            try:
                result = get_servers()
            except DiscoveryUnavailable as e:
                self._send_json(503, {"error": str(e)})
                return
            except Exception as e:
                print(f"Server discovery failed: {e}", file=sys.stderr)
                self._send_json(500, {"error": "Server list unavailable"})
                return
            self._send_json(200, result)
            return

        if path_only == "/api/dashboard":
            # Read-only: never triggers a sync or any other outbound call.
            try:
                body = json.dumps(get_dashboard()).encode("utf-8")
            except Exception as e:
                print(f"Dashboard read model failed: {e}", file=sys.stderr)
                self.send_error(500, "Dashboard state unavailable")
                return
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
            return

        web_dir = os.path.realpath(os.path.join(os.path.dirname(__file__), "web"))
        target_path = path_only.lstrip("/")
        if not target_path or target_path == "":
            target_path = "index.html"

        safe_path = os.path.realpath(os.path.join(web_dir, target_path))
        if os.path.commonpath([web_dir, safe_path]) != web_dir:
            self.send_error(403, "Access denied")
            return

        if os.path.exists(safe_path) and os.path.isfile(safe_path):
            if safe_path.endswith(".html"):
                try:
                    with open(safe_path, "r", encoding="utf-8") as f:
                        html_content = f.read()
                    csrf_tag = f'<meta name="csrf-token" content="{get_csrf_token()}">\n</head>'
                    html_content = html_content.replace("</head>", csrf_tag, 1)
                    self.send_response(200)
                    self.send_header("Content-Type", "text/html; charset=utf-8")
                    self.end_headers()
                    self.wfile.write(html_content.encode("utf-8"))
                    return
                except Exception:
                    pass

            self.send_response(200)
            if safe_path.endswith(".html"):
                self.send_header("Content-Type", "text/html")
            elif safe_path.endswith(".css"):
                self.send_header("Content-Type", "text/css")
            elif safe_path.endswith(".js"):
                self.send_header("Content-Type", "application/javascript")
            elif safe_path.endswith(".svg"):
                self.send_header("Content-Type", "image/svg+xml")
            elif safe_path.endswith(".png"):
                self.send_header("Content-Type", "image/png")
            elif safe_path.endswith(".ico"):
                self.send_header("Content-Type", "image/x-icon")
            else:
                self.send_header("Content-Type", "application/octet-stream")
            self.end_headers()

            with open(safe_path, "rb") as f:
                self.wfile.write(f.read())
        else:
            self.send_error(404, "File not found")

    def _send_json(self, status_code, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _read_json_body(self, max_bytes):
        """The request's JSON body, or None after sending a 400."""
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self._send_json(400, {"error": "Invalid Content-Length header"})
            return None
        if length <= 0 or length > max_bytes:
            self._send_json(400, {"error": f"Request body must be between 1 and {max_bytes} bytes"})
            return None
        try:
            raw_body = self.rfile.read(length)
            return json.loads(raw_body.decode("utf-8"))
        except (OSError, ValueError):
            self._send_json(400, {"error": "Invalid JSON body"})
            return None

    def do_POST(self):
        if not self.is_trusted_request():
            return
        path_only = self.path.partition('?')[0].partition('#')[0]
        if path_only == "/api/reachability":
            payload = self._read_json_body(REACHABILITY_MAX_BODY_BYTES)
            if payload is None:
                return
            try:
                status_code, response_body = check_reachability(payload)
            except Exception as e:
                print(f"Reachability check failed: {e}", file=sys.stderr)
                self._send_json(500, {"error": "Could not run the reachability check"})
                return
            self._send_json(status_code, response_body)
            return
        if path_only == "/api/intents":
            payload = self._read_json_body(INTENT_MAX_BODY_BYTES)
            if payload is None:
                return
            try:
                status_code, response_body = submit_dashboard_intent(payload)
            except Exception as e:
                print(f"Dashboard intent submission failed: {e}", file=sys.stderr)
                self._send_json(500, {"error": "Could not queue dashboard request"})
                return
            self._send_json(status_code, response_body)
            return
        self.send_error(404, "Not found")

def web_server_thread():
    try:
        server = ThreadingHTTPServer(("0.0.0.0", 80), DashboardHTTPRequestHandler)
        print("Web UI Dashboard server running on port 80...")
        server.serve_forever()
    except Exception as e:
        print(f"Failed to start web server on port 80: {e}", file=sys.stderr)

def is_enabled():
    global _enabled_cache, _enabled_cache_mtime
    try:
        if os.path.exists(APP_CONFIG_PATH):
            try:
                mtime = os.path.getmtime(APP_CONFIG_PATH)
                if mtime != _enabled_cache_mtime:
                    with open(APP_CONFIG_PATH, 'r') as f:
                        config_data = json.load(f)
                    if "enabled" in config_data:
                        val = config_data["enabled"]
                        _enabled_cache = val if val is not None else False
                    else:
                        _enabled_cache = None
                    _enabled_cache_mtime = mtime
                if _enabled_cache is not None:
                    return _enabled_cache
            except Exception:
                pass
        # Default to True if a v3 config exists (upgrade path/existing configurations)
        if os.path.exists(CONFIG_PATH):
            return True
    except Exception as e:
        print(f"Error checking enabled status: {e}", file=sys.stderr)
    return False

def is_allow_ipv6():
    try:
        if os.path.exists(APP_CONFIG_PATH):
            with open(APP_CONFIG_PATH, 'r') as f:
                config_data = json.load(f)
                return config_data.get("allow-ipv6", False)
    except Exception as e:
        print(f"Error checking allow-ipv6 status: {e}", file=sys.stderr)
    return False

def extract_vpn_port(config_content):
    try:
        # Match either "# VPNPort: 12345" or "# Port Forwarding: 12345"
        match = re.search(r'#\s*(?:VPNPort|Port Forwarding):\s*(\d+)', config_content, re.IGNORECASE)
        if match:
            return int(match.group(1))
    except (ValueError, IndexError):
        pass
    return DEFAULT_VPN_PORT

def get_target_details():
    """
    Returns (target_host, target_port) based on the target node config.
    """
    env_addr = os.environ.get("TARGET_NODE_ADDR")
    if env_addr:
        try:
            host, port = env_addr.split(":")
            return host, int(port)
        except Exception as e:
            print(f"Error parsing TARGET_NODE_ADDR '{env_addr}': {e}", file=sys.stderr)

    target = "lnd"
    try:
        if os.path.exists(APP_CONFIG_PATH):
            with open(APP_CONFIG_PATH, 'r') as f:
                config_data = json.load(f)
                target = config_data.get("target-node", "lnd")
    except Exception as e:
        print(f"Error reading target node from config: {e}", file=sys.stderr)

    # Map to StartOS service ID and default port
    if target in ("cln", "c-lightning"):
        hostname = "c-lightning.embassy"
    elif target == "eclair":
        hostname = "eclair.embassy"
    else:
        hostname = "lnd.embassy"
    return hostname, 9735



def get_wg_ip():
    try:
        if os.path.exists(CONFIG_PATH):
            with open(CONFIG_PATH, "r") as f:
                config_content = f.read()
            match = re.search(r"^\s*(?!#|;)\s*Address\s*=\s*([0-9\.]+)", config_content, re.IGNORECASE | re.MULTILINE)
            if match:
                return match.group(1)
    except Exception as e:
        print(f"Error parsing WG IP: {e}", file=sys.stderr)
    return None

def shutdown_handler(signum, frame):
    print("Received shutdown signal. Stopping TunnelSats companion services...")
    sys.exit(0)

def get_subscription_info(current_pubkey=None):
    """Subscription state for display and health.

    Only an expiry the API confirmed (expirySource == "api") counts, and when
    current_pubkey is given, only one confirmed for that key. Without meta,
    the # Valid Until comment is shown as a pending hint; it can mark the
    subscription expired (fail closed) but never active.
    """
    if not os.path.exists(META_FILE_PATH):
        if os.path.exists(CONFIG_PATH):
            try:
                with open(CONFIG_PATH, 'r') as f:
                    config_content = f.read()
                parsed = parse_config_comments(config_content)
                expiry = parsed.get("expiresAt")
                if expiry and is_valid_iso_expiry(expiry):
                    expiry_dt = datetime.fromisoformat(expiry.replace("Z", "+00:00"))
                    if expiry_dt.tzinfo is None:
                        expiry_dt = expiry_dt.replace(tzinfo=timezone.utc)
                    now = datetime.now(timezone.utc)
                    delta = expiry_dt - now
                    is_expired = delta.total_seconds() <= 0
                    return {
                        "linked": False,
                        "expiresAt": expiry,
                        "daysRemaining": max(0, delta.days) if not is_expired else 0,
                        "formatted": f"Pending subscription synchronization (Expires in {delta.days}d)" if not is_expired else f"Expired on {expiry_dt.strftime('%Y-%m-%d')}",
                        "isExpired": is_expired,
                        "lastSync": None,
                        "syncError": None,
                        "syncSuccess": False
                    }
            except Exception:
                pass

        return {
            "linked": False,
            "expiresAt": None,
            "daysRemaining": None,
            "formatted": "Unconfigured",
            "isExpired": False,
            "lastSync": None,
            "syncError": None,
            "syncSuccess": False,
            "bandwidthUsedGb": 0.0,
        }

    try:
        with open(META_FILE_PATH, 'r') as f:
            meta = json.load(f)
        # Everything recorded by a sync belongs to the key it ran for. A new
        # key inherits neither the old expiry nor the old sync error (which
        # would stop health from syncing the new key right away).
        same_key = current_pubkey is None or meta.get("publicKey") == current_pubkey
        confirmed = meta.get("expirySource") == "api" and same_key
        expires_at = meta.get("expiresAt") if confirmed else None
        last_sync = meta.get("lastSync") if confirmed else None
        sync_error = meta.get("syncError") if same_key else None
        sync_success = meta.get("syncSuccess", False) if same_key else False
        key_unknown = same_key and meta.get("keyUnknown") is True

        has_synced = bool(sync_success or (last_sync is not None and not sync_error))

        if not expires_at:
            return {
                "linked": False,
                "expiresAt": None,
                "daysRemaining": None,
                "formatted": f"Sync failed: {sync_error}" if sync_error else "Pending subscription synchronization",
                "isExpired": False,
                "lastSync": last_sync,
                "syncError": sync_error,
                "syncSuccess": sync_success,
                "keyUnknown": key_unknown,
            }

        expiry_dt = datetime.fromisoformat(expires_at.replace("Z", "+00:00"))
        if expiry_dt.tzinfo is None:
            expiry_dt = expiry_dt.replace(tzinfo=timezone.utc)
        now = datetime.now(timezone.utc)
        delta = expiry_dt - now
        days = delta.days
        is_expired = delta.total_seconds() <= 0

        if is_expired:
            formatted = f"Expired on {expiry_dt.strftime('%Y-%m-%d')}"
        elif days > 0:
            formatted = f"Active (Expires in {days}d {delta.seconds // 3600}h)"
        else:
            formatted = f"Active (Expires in {delta.seconds // 3600}h {(delta.seconds % 3600) // 60}m)"

        return {
            "linked": has_synced and not key_unknown,
            "expiresAt": expires_at,
            "daysRemaining": max(0, days) if not is_expired else 0,
            "formatted": formatted if has_synced else (f"Sync failed: {sync_error}" if sync_error else "Pending subscription synchronization"),
            "isExpired": is_expired,
            "lastSync": last_sync,
            "syncError": sync_error,
            "syncSuccess": sync_success,
            "bandwidthUsedGb": meta.get("bandwidth_used_gb", 0.0),
            "keyUnknown": key_unknown,
        }
    except Exception as e:
        return {
            "linked": False,
            "expiresAt": None,
            "daysRemaining": None,
            "formatted": f"Error: {e}",
            "isExpired": False,
            "lastSync": None,
            "syncError": str(e),
            "syncSuccess": False
        }

def _strip_endpoint_port(endpoint):
    endpoint = endpoint.strip()
    if endpoint.startswith("["):
        closing = endpoint.find("]")
        if closing != -1:
            return endpoint[1:closing].strip()
        return endpoint.lstrip("[")
    last_colon = endpoint.rfind(":")
    if last_colon != -1:
        host_part = endpoint[:last_colon]
        try:
            ipaddress.IPv6Address(host_part)
            return host_part
        except ValueError:
            pass
    try:
        ipaddress.IPv6Address(endpoint)
        return endpoint
    except ValueError:
        pass
    return endpoint.partition(":")[0]


def extract_server_host(config_content):
    server_match = re.search(r"^#\s*Server:\s*([^\s#]+)", config_content, re.IGNORECASE | re.MULTILINE)
    if server_match:
        server = server_match.group(1).strip()
        if server.startswith("[") and server.endswith("]"):
            return server[1:-1]
        return server
    endpoint_match = re.search(r"^\s*(?!#|;)\s*Endpoint\s*=\s*([^\s#;]+)", config_content, re.IGNORECASE | re.MULTILINE)
    if endpoint_match:
        host = _strip_endpoint_port(endpoint_match.group(1))
        if host:
            return host
    return "Unknown"


def get_status():
    enabled = is_enabled()
    has_config = os.path.exists(CONFIG_PATH)

    vpn_ip = get_wg_ip() if (enabled and has_config) else None
    internal_octet = vpn_ip.split('.')[-1] if vpn_ip else "Unknown"

    vpn_port = DEFAULT_VPN_PORT
    server_domain = "Unknown"
    if has_config:
        try:
            with open(CONFIG_PATH, "r") as f:
                content = f.read()
            vpn_port = extract_vpn_port(content)
            server_domain = extract_server_host(content)
        except Exception:
            pass

    current_pubkey = get_wg_pubkey() if has_config else None
    sub_info = get_subscription_info(current_pubkey)
    if (server_domain == "Unknown" or not server_domain) and sub_info.get("serverDomain"):
        server_domain = sub_info["serverDomain"]

    if not enabled:
        status = "disabled"
    elif not has_config:
        status = "unconfigured"
    elif sub_info["isExpired"]:
        status = "expired"
    elif sub_info["linked"]:
        status = "running"
    elif sub_info.get("keyUnknown"):
        status = "unknown_key"
    elif sub_info.get("syncError"):
        status = "sync_error"
    else:
        status = "pending_sync"

    is_active = (enabled and has_config and sub_info["linked"] and not sub_info["isExpired"])

    return {
        "status": status,
        "enabled": enabled,
        "configured": has_config,
        "subscription_active": is_active,
        "subscription_linked": sub_info["linked"],
        "expires_at": sub_info["expiresAt"] or "Unknown",
        "days_remaining": sub_info["daysRemaining"],
        "expiry_formatted": sub_info["formatted"],
        "vpn_ip": vpn_ip or "None",
        "vpn_port": vpn_port,
        "public_ip": server_domain,
        "server": server_domain,
        "internal_octet": internal_octet,
        "pubkey": current_pubkey if has_config else "None",
        "last_sync": sub_info["lastSync"],
        "sync_error": sub_info.get("syncError"),
        "key_unknown": bool(sub_info.get("keyUnknown")),
        "bandwidth_used_gb": sub_info.get("bandwidthUsedGb", 0.0),
        "bandwidth_limit_gb": confirmed_bandwidth_limit(read_meta(), current_pubkey),
        "version": get_package_version(),
        "allow_ipv6": is_allow_ipv6(),
    }

# ─── Dashboard read model & intent bridge ────────────────────────────────────
# GET /api/dashboard and POST /api/intents. The dashboard is reachable from the
# LAN without operator authentication, so it only ever sees what this allow-list
# copies out of the state files: never a private key, a payment hash, the
# WireGuard configuration or any field not named here. Only an unpaid,
# non-expired BOLT11 invoice is exposed so the operator can scan or copy the
# exact same invoice raised on the Lightning node. Every value is type-checked
# and bounded, so a malformed or tampered file cannot pass other data through
# an allowed name.

DASHBOARD_TEXT_LIMIT = 300
# Shown until the API confirmed the limit for the current key.
BANDWIDTH_LIMIT_GB = 100
# The server's default usage threshold for a paid bandwidth reset. The server
# may configure another one and decides; the dashboard only uses it as a hint.
RESET_THRESHOLD_DEFAULT_PCT = 70
BASE_PRICE_USD = 3.0
PLAN_DISCOUNTS_PCT = ((1, 0), (3, 5), (6, 10), (12, 20))
PLAN_PRICES_USD = [
    {
        "months": months,
        "usd": round(BASE_PRICE_USD * months * (100 - discount_pct) / 100, 2),
        "discountPct": discount_pct,
    }
    for months, discount_pct in PLAN_DISCOUNTS_PCT
]
HANDOFF_PACKAGE_IDS = ("lnd", "c-lightning", "eclair")
NOTICE_KINDS = ("7d", "3d", "lapsed")
INVOICE_DEFAULT_TTL = timedelta(hours=1)
INTENT_KINDS = ("buy", "renew", "reset")
INTENT_DURATIONS = ("1m", "3m", "6m", "12m")
INTENT_TTL = timedelta(seconds=120)
INTENT_RATE_LIMIT_WINDOW = timedelta(seconds=30)
INTENT_HOURLY_WINDOW = timedelta(hours=1)
INTENT_HOURLY_CAP = 5
INTENT_MAX_BODY_BYTES = 4096
_HEX64_RE = re.compile(r"\b[0-9a-fA-F]{64}\b")
_BOLT11_RE = re.compile(r"^ln(?:bcrt|bc|tbs|tb|sb)[0-9a-z]{20,4000}$", re.IGNORECASE)
_BOLT11_AMOUNT_RE = re.compile(r"^ln(?:bcrt|bc|tbs|tb|sb)(?:(\d+)([munp])?)?1[0-9a-z]{7,}$", re.IGNORECASE)
_SERVER_ID_RE = re.compile(r"^[A-Za-z0-9_-]{2,32}$")
_PAID_ERROR_RE = re.compile(
    r"payment was received|renewal is paid|bandwidth reset was applied|"
    r"bandwidth reset failed|claim|Provisioning failed|stored private key",
    re.IGNORECASE,
)


def _bolt11_amount_sats(invoice):
    """Amount in whole satoshis from a BOLT11 invoice's human-readable part,
    or None when omitted, sub-satoshi, or unparseable."""
    if not isinstance(invoice, str):
        return None
    m = _BOLT11_AMOUNT_RE.match(invoice.strip())
    if not m or not m.group(1):
        return None
    value = int(m.group(1))
    unit = (m.group(2) or "").lower()
    msat_per_unit = {"": 100_000_000_000, "m": 100_000_000, "u": 100_000, "n": 100, "p": 0.1}.get(unit)
    if msat_per_unit is None:
        return None
    msats = round(value * msat_per_unit)
    if msats <= 0 or msats % 1000 != 0:
        return None
    return msats // 1000


def _dashboard_text(value, limit=DASHBOARD_TEXT_LIMIT):
    if not isinstance(value, str) or not value.strip():
        return None
    value = value.strip()
    return value if len(value) <= limit else value[:limit - 1] + "…"


def _dashboard_error_text(value, pending=None):
    text = _dashboard_text(value, limit=1024)
    if text is None:
        return None
    text = re.sub(
        r"with payment hash\s+[0-9a-fA-F]{64}",
        "with the payment hash from the Reset Bandwidth action",
        text,
        flags=re.IGNORECASE,
    )
    if isinstance(pending, dict):
        for field in ("paymentHash", "orderId", "renewalId", "resetId", "privateKey", "invoice"):
            secret = pending.get(field)
            if isinstance(secret, str) and len(secret) >= 4:
                text = text.replace(secret, "[redacted]")
    text = _HEX64_RE.sub("[redacted]", text)
    return _dashboard_text(text)


def _dashboard_short_text(value):
    return _dashboard_text(value, 64)


def _dashboard_time(value):
    dt = _parse_iso(value)
    return _iso(dt) if dt is not None else None


def _dashboard_amount(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return value if math.isfinite(value) and value >= 0 else None


def _dashboard_node(value):
    return value if value in TARGET_NODES else None


def _dashboard_duration(value):
    """'1m'..'12m', from the wire format or the whole months TypeScript stores
    in tunnelsats-meta.json; None for anything else."""
    if isinstance(value, bool):
        return None
    if isinstance(value, int) and f"{value}m" in INTENT_DURATIONS:
        return f"{value}m"
    return value if value in INTENT_DURATIONS else None


def _dashboard_server_id(value):
    return value if isinstance(value, str) and _SERVER_ID_RE.match(value) else None


def _read_json_object(path):
    try:
        with open(path, "r") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def get_target_node():
    """The configured target node; "lnd" when config.json is missing or holds
    anything else (the same default as the TypeScript file model)."""
    data = _read_json_object(APP_CONFIG_PATH) or {}
    node = data.get("target-node")
    return node if node in TARGET_NODES else "lnd"


# Per pending payment: the fields the dashboard may see, each with its
# sanitizer. paymentHash, privateKey, publicKey and the order, renewal and
# reset IDs are deliberately absent. Only an unpaid, non-expired BOLT11
# invoice is copied onto summary["invoice"] in _pending_summary().
_PENDING_SUMMARY_FIELDS = {
    "pendingOrder": {
        "targetNode": _dashboard_node,
        "serverId": _dashboard_short_text,
        "duration": _dashboard_duration,
        "createdAt": _dashboard_time,
        "expiresAt": _dashboard_time,
        "amountSats": _dashboard_amount,
        "lastError": _dashboard_text,
        "nextAttemptAt": _dashboard_time,
    },
    "pendingRenewal": {
        "targetNode": _dashboard_node,
        "duration": _dashboard_duration,
        "createdAt": _dashboard_time,
        "expiresAt": _dashboard_time,
        "amountSats": _dashboard_amount,
        "oldExpiry": _dashboard_time,
        "newExpiry": _dashboard_time,
        "lastError": _dashboard_text,
        "nextAttemptAt": _dashboard_time,
    },
    "pendingReset": {
        "targetNode": _dashboard_node,
        "createdAt": _dashboard_time,
        "expiresAt": _dashboard_time,
        "amountSats": _dashboard_amount,
        "lastError": _dashboard_text,
        "nextAttemptAt": _dashboard_time,
    },
}


def _pending_summary(meta, key, public_key=None, now=None):
    """A summary of meta[key], or None when no payment is pending there for
    the current key. Exposes `invoice` only while unpaid and not expired."""
    pending = meta.get(key)
    if not isinstance(pending, dict) or not isinstance(pending.get("paymentHash"), str) \
            or not pending["paymentHash"]:
        return None
    if key in ("pendingRenewal", "pendingReset"):
        if public_key is None or pending.get("publicKey") != public_key:
            return None
    elif key == "pendingOrder" and public_key is not None and pending.get("publicKey") == public_key:
        return None
    now = now or datetime.now(timezone.utc)
    summary = {name: clean(pending.get(name)) for name, clean in _PENDING_SUMMARY_FIELDS[key].items()}
    summary["lastError"] = _dashboard_error_text(pending.get("lastError"), pending)
    summary["paymentReceived"] = bool(
        pending.get("paymentReceivedFor") == pending["paymentHash"]
        or (isinstance(pending.get("lastError"), str) and _PAID_ERROR_RE.search(pending["lastError"]))
    )
    raw_inv = pending.get("invoice")
    valid_inv = raw_inv.strip().lower() if isinstance(raw_inv, str) and _BOLT11_RE.match(raw_inv.strip()) else None
    created_dt = _parse_iso(pending.get("createdAt"))
    expires_dt = _parse_iso(pending.get("expiresAt"))
    effective_expires_dt = expires_dt or (
        created_dt + INVOICE_DEFAULT_TTL if created_dt is not None and valid_inv is not None else None
    )
    if (
        valid_inv is not None
        and not summary["paymentReceived"]
        and effective_expires_dt is not None
        and now < effective_expires_dt
    ):
        summary["invoice"] = valid_inv
        if summary.get("expiresAt") is None:
            summary["expiresAt"] = _iso(effective_expires_dt)
        if summary.get("amountSats") is None:
            summary["amountSats"] = _bolt11_amount_sats(valid_inv)
    else:
        summary["invoice"] = None
    return summary


def _package_ids(value):
    if not isinstance(value, list):
        return []
    return list(dict.fromkeys(p for p in value if p in HANDOFF_PACKAGE_IDS))


def _handoff_summary():
    """Which node holds the tunnel and which still owe an off, from
    vpn-handoff.json (written by setDependencies); None without a record."""
    data = _read_json_object(HANDOFF_FILE_PATH)
    if data is None:
        return None
    active = data.get("activeTarget")
    return {
        "activeTarget": active if active in HANDOFF_PACKAGE_IDS else None,
        "pendingOff": _package_ids(data.get("pendingOff")),
        "unraised": _package_ids(data.get("unraised")),
    }


def _notices_summary(public_key):
    """The subscription notices already posted for public_key (written by the
    Subscription health check); None without a record or a key."""
    data = _read_json_object(NOTICES_FILE_PATH)
    if data is None or not public_key:
        return None
    sent = data.get("sent") if data.get("publicKey") == public_key else None
    return {
        "sent": [kind for kind in NOTICE_KINDS if isinstance(sent, list) and kind in sent],
        "unknownKey": data.get("unknownKey") == public_key,
    }


def _intent_slot_summary(kind, req_slot, res_slot, now):
    if not isinstance(req_slot, dict) or req_slot.get("kind") != kind:
        return None
    intent_id = _dashboard_short_text(req_slot.get("id"))
    created_dt = _parse_iso(req_slot.get("createdAt"))
    if intent_id is None or created_dt is None:
        return None
    created_at = _iso(created_dt)
    if kind == "buy":
        server_id = _dashboard_server_id(req_slot.get("serverId"))
        duration = _dashboard_duration(req_slot.get("duration"))
        if server_id is None or duration is None:
            return None
    elif kind == "renew":
        server_id = None
        duration = _dashboard_duration(req_slot.get("duration"))
        if duration is None:
            return None
    else:
        server_id = None
        duration = None

    status = "pending"
    updated_at = created_at
    error = None
    if isinstance(res_slot, dict) and res_slot.get("id") == intent_id:
        res_status = res_slot.get("status")
        # The statuses startos/intentRunner.ts writes.
        if res_status in ("processing", "succeeded", "failed"):
            status = res_status
            updated_at = _dashboard_time(res_slot.get("updatedAt")) or created_at
            if status == "failed":
                error = _dashboard_error_text(res_slot.get("error")) or "The request failed."
    # The runner refuses intents older than INTENT_TTL, so one it never
    # picked up has failed. One it picked up stays "processing" until the
    # runner records the outcome: the runner re-runs a processing slot after
    # a restart and then records it, so it never stays processing for good.
    if status == "pending" and now - created_dt >= INTENT_TTL:
        status = "failed"
        error = "The dashboard request timed out before StartOS processed it. Please try again."

    summary = {
        "id": intent_id,
        "kind": kind,
        "status": status,
        "createdAt": created_at,
        "updatedAt": updated_at,
        "error": error,
    }
    if kind == "buy":
        summary["serverId"] = server_id
        summary["duration"] = duration
        summary["targetNode"] = _dashboard_node(req_slot.get("targetNode"))
    elif kind == "renew":
        summary["duration"] = duration
    return summary


def _intents_summary(now=None):
    """Per-kind intent state merged from dashboard-intents.json (written by
    bridge.py) and dashboard-intent-results.json (written by TypeScript)."""
    now = now or datetime.now(timezone.utc)
    intents_data = _read_json_object(INTENTS_FILE_PATH) or {}
    results_data = _read_json_object(INTENT_RESULTS_FILE_PATH) or {}
    return {
        kind: _intent_slot_summary(kind, intents_data.get(kind), results_data.get(kind), now)
        for kind in INTENT_KINDS
    }


@contextmanager
def intents_lock():
    """Exclusive cross-thread/process lock around dashboard-intents.json."""
    fd = os.open(INTENTS_FILE_PATH + ".lock", os.O_RDWR | os.O_CREAT, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        yield
    finally:
        os.close(fd)


def _current_configured_pubkey():
    if not os.path.exists(CONFIG_PATH):
        return None
    pubkey = get_wg_pubkey()
    if pubkey in ("Unknown", "None", "Not available") or not isinstance(pubkey, str):
        return None
    return pubkey


def submit_dashboard_intent(payload, now=None):
    """Validates a POST /api/intents request, enforces rate limits, and
    writes the single-writer dashboard-intents.json slot. Returns
    (http_status, response_dict)."""
    if not isinstance(payload, dict):
        return 400, {"error": "Request body must be a JSON object"}
    kind = payload.get("kind")
    if kind not in INTENT_KINDS:
        return 400, {"error": "Invalid intent kind; expected 'buy', 'renew', or 'reset'"}

    expected_keys = {
        "buy": {"kind", "serverId", "duration"},
        "renew": {"kind", "duration"},
        "reset": {"kind"},
    }[kind]
    if set(payload.keys()) != expected_keys:
        return 400, {"error": f"Unexpected or missing fields for '{kind}' intent"}

    server_id = None
    duration = None
    if kind in ("buy", "renew"):
        # Strict wire format: exactly one of INTENT_DURATIONS.
        duration = payload.get("duration") if payload.get("duration") in INTENT_DURATIONS else None
        if duration is None:
            return 400, {"error": "Invalid duration; expected '1m', '3m', '6m', or '12m'"}
    if kind == "buy":
        server_id = _dashboard_server_id(payload.get("serverId"))
        if server_id is None:
            return 400, {"error": "Invalid serverId"}

    public_key = _current_configured_pubkey()
    if kind in ("renew", "reset") and public_key is None:
        action_label = "renew" if kind == "renew" else "reset bandwidth"
        return 409, {"error": f"Cannot {action_label} before a WireGuard configuration is installed."}

    # Whether a payable invoice of this kind is reused, refused as a
    # conflicting selection or replaced is decided in one place: the shared
    # action core the runner calls (keepPayable). Re-submitting an identical
    # request therefore also raises a Pay Invoice task that failed to raise.
    now = now or datetime.now(timezone.utc)

    import secrets
    with intents_lock():
        intents_data = _read_json_object(INTENTS_FILE_PATH) or {}
        results_data = _read_json_object(INTENT_RESULTS_FILE_PATH) or {}

        current_slot = _intent_slot_summary(
            kind, intents_data.get(kind), results_data.get(kind), now
        )
        if current_slot is not None and current_slot["status"] in ("pending", "processing"):
            return 429, {
                "error": f"A {kind} request is already in progress.",
                "retryAfterSeconds": 5,
            }

        raw_history = intents_data.get("history")
        recent_history = []
        if isinstance(raw_history, list):
            for entry in raw_history:
                if not isinstance(entry, dict):
                    continue
                e_id = _dashboard_short_text(entry.get("id"))
                e_kind = entry.get("kind")
                e_dt = _parse_iso(entry.get("createdAt"))
                if e_id and e_kind in INTENT_KINDS and e_dt is not None:
                    age = now - e_dt
                    if timedelta(0) <= age < INTENT_HOURLY_WINDOW:
                        recent_history.append({
                            "id": e_id,
                            "kind": e_kind,
                            "createdAt": _iso(e_dt),
                            "_dt": e_dt,
                        })

        for entry in recent_history:
            if entry["kind"] == kind:
                elapsed = now - entry["_dt"]
                if elapsed < INTENT_RATE_LIMIT_WINDOW:
                    retry_after = max(1, math.ceil((INTENT_RATE_LIMIT_WINDOW - elapsed).total_seconds()))
                    return 429, {
                        "error": f"Please wait {retry_after}s before repeating this request.",
                        "retryAfterSeconds": retry_after,
                    }

        if len(recent_history) >= INTENT_HOURLY_CAP:
            oldest_dt = min(entry["_dt"] for entry in recent_history)
            retry_after = max(1, math.ceil((INTENT_HOURLY_WINDOW - (now - oldest_dt)).total_seconds()))
            return 429, {
                "error": "Too many payment requests in the last hour. Please pay the existing invoice or wait before trying again.",
                "retryAfterSeconds": retry_after,
            }

        intent_id = f"{kind}-{int(now.timestamp() * 1000)}-{secrets.token_hex(4)}"
        created_at = _iso(now)
        new_slot = {
            "id": intent_id,
            "kind": kind,
            "createdAt": created_at,
        }
        if kind == "buy":
            new_slot["serverId"] = server_id
            new_slot["duration"] = duration
            # The configured node, as the Buy action defaults to; the runner
            # raises the Pay Invoice task there.
            new_slot["targetNode"] = get_target_node()
        elif kind == "renew":
            new_slot["duration"] = duration

        clean_history = [
            {"id": e["id"], "kind": e["kind"], "createdAt": e["createdAt"]}
            for e in recent_history
        ]
        clean_history.append({"id": intent_id, "kind": kind, "createdAt": created_at})

        next_doc = {}
        for k in INTENT_KINDS:
            if k == kind:
                next_doc[k] = new_slot
            elif isinstance(intents_data.get(k), dict):
                next_doc[k] = intents_data[k]
        next_doc["history"] = clean_history
        atomic_write_json(INTENTS_FILE_PATH, next_doc)

    intent_view = dict(new_slot)
    intent_view["status"] = "pending"
    intent_view["updatedAt"] = created_at
    intent_view["error"] = None
    return 202, {"status": "accepted", "intent": intent_view}


# ─── Server discovery & inbound reachability ─────────────────────────────────
# GET /api/servers and POST /api/reachability are the only dashboard routes
# that call out (to the TunnelSats API), and both are bounded. The server
# list is cached for SERVERS_CACHE_TTL; while the API fails the last list is
# served marked stale, and the API is asked again after SERVERS_RETRY_AFTER
# at the earliest. The reachability check asks TunnelSats to open a Lightning
# connection to the operator's node through the VPN server's forwarded port:
# it proves inbound reachability only, never that outbound traffic leaves
# through the tunnel. It takes nothing but the node's public key; the probed
# host (a TunnelSats hostname) and port (the configuration's explicit
# forwarded-port marker) come from the stored configuration, so a request
# cannot aim the probe anywhere else. At most REACHABILITY_LIMIT checks run
# per REACHABILITY_WINDOW for the whole process (the API allows 3 per minute
# per IP).

SERVERS_CACHE_TTL = 60
SERVERS_RETRY_AFTER = 15
SERVERS_MAX = 32
SERVERS_MAX_RESPONSE_BYTES = 64 * 1024
REACHABILITY_LIMIT = 2
REACHABILITY_WINDOW = 60
REACHABILITY_TIMEOUT = 30
REACHABILITY_MAX_BODY_BYTES = 512
REACHABILITY_MAX_RESPONSE_BYTES = 16 * 1024
REACHABILITY_MAX_LATENCY_MS = 600_000
_NODE_PUBKEY_RE = re.compile(r"^0[23][0-9a-f]{64}$")
_TUNNELSATS_HOST_RE = re.compile(r"^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+tunnelsats\.com$")
_SERVER_STATUS_RE = re.compile(r"^[a-z_-]{1,16}$")

_servers_lock = threading.Lock()
_servers_fetch_lock = threading.Lock()
_servers_cache = {}
_reachability_lock = threading.Lock()
_reachability_calls = collections.deque()


class DiscoveryUnavailable(Exception):
    pass


def _reset_discovery_state():
    with _servers_lock:
        _servers_cache.clear()
    with _reachability_lock:
        _reachability_calls.clear()


def _server_entry(entry):
    """One server from the API, reduced to the allow-listed fields; None
    without a valid id."""
    if not isinstance(entry, dict):
        return None
    server_id = _dashboard_server_id(entry.get("id"))
    if server_id is None:
        return None
    status = entry.get("status")
    return {
        "id": server_id,
        "country": _dashboard_text(entry.get("country"), 64),
        "city": _dashboard_text(entry.get("city"), 64),
        "flag": _dashboard_text(entry.get("flag"), 16),
        "status": status if isinstance(status, str) and _SERVER_STATUS_RE.match(status) else None,
    }


def _fetch_servers():
    req = urllib.request.Request(
        f"{TUNNELSATS_API_URL}/servers",
        headers={"Accept": "application/json", "User-Agent": f"TunnelSats-StartOS/{get_package_version()}"},
        method="GET",
    )
    with urllib.request.urlopen(req, timeout=10) as response:
        data = json.loads(response.read(SERVERS_MAX_RESPONSE_BYTES).decode("utf-8"))
    if not isinstance(data, dict) or not isinstance(data.get("servers"), list):
        raise ValueError("TunnelSats API returned an unexpected server list")
    servers = []
    seen = set()
    for raw in data["servers"]:
        entry = _server_entry(raw)
        if entry is not None and entry["id"] not in seen:
            seen.add(entry["id"])
            servers.append(entry)
        if len(servers) >= SERVERS_MAX:
            break
    if not servers:
        raise ValueError("TunnelSats API returned no usable server")
    return servers


def _servers_result(stale):
    """The cached list as a response; the caller holds _servers_lock."""
    return {"servers": [dict(s) for s in _servers_cache["servers"]], "stale": stale,
            "fetchedAt": _servers_cache["fetchedAt"]}


def _servers_state(now):
    """(fresh response or None, whether the API may be asked now, whether a
    list is cached); the caller holds _servers_lock."""
    cached = _servers_cache.get("servers")
    if cached is not None and now - _servers_cache["at"] < SERVERS_CACHE_TTL:
        return _servers_result(False), False, True
    failed_at = _servers_cache.get("failedAt")
    may_fetch = failed_at is None or now - failed_at >= SERVERS_RETRY_AFTER
    return None, may_fetch, cached is not None


def get_servers():
    """The TunnelSats server list for the dashboard: {servers, stale,
    fetchedAt}. Raises DiscoveryUnavailable when no list was ever fetched.

    One request at a time asks the API (_servers_fetch_lock), and never while
    holding _servers_lock: with a list cached, other requests get it marked
    stale right away instead of waiting for a slow API; only while no list
    exists at all do they wait for the fetch in flight."""
    with _servers_lock:
        fresh, may_fetch, has_list = _servers_state(time.monotonic())
    if fresh is not None:
        return fresh
    if may_fetch and _servers_fetch_lock.acquire(blocking=not has_list):
        try:
            # Another request may have refreshed (or failed) while this one
            # waited for the fetch lock.
            with _servers_lock:
                fresh, may_fetch, _ = _servers_state(time.monotonic())
            if fresh is not None:
                return fresh
            if may_fetch:
                try:
                    servers = _fetch_servers()
                except Exception as e:
                    print(f"Could not fetch the TunnelSats server list: {e}", file=sys.stderr)
                    with _servers_lock:
                        _servers_cache["failedAt"] = time.monotonic()
                else:
                    with _servers_lock:
                        _servers_cache.update(servers=servers, at=time.monotonic(),
                                              fetchedAt=_iso(datetime.now(timezone.utc)), failedAt=None)
                        return _servers_result(False)
        finally:
            _servers_fetch_lock.release()
    with _servers_lock:
        if _servers_cache.get("servers") is not None:
            return _servers_result(True)
    raise DiscoveryUnavailable("The TunnelSats server list is unavailable right now. Please try again later.")


def _reachability_target():
    """(host, port, None) to probe, from the stored configuration, or
    (None, None, reason)."""
    try:
        with open(CONFIG_PATH, "r") as f:
            content = f.read()
    except OSError:
        return None, None, "Install a WireGuard configuration first."
    host = extract_server_host(content).strip().lower()
    if not _TUNNELSATS_HOST_RE.match(host):
        return None, None, "The configured VPN server is not a TunnelSats hostname; only TunnelSats servers are checked."
    marker = VPN_PORT_MARKER_RE.search(content)
    port = valid_vpn_port(int(marker.group(2))) if marker else None
    if port is None:
        return None, None, "No forwarded VPN port is known for this configuration yet."
    return host, port, None


def check_reachability(payload):
    """Validates a POST /api/reachability request and asks TunnelSats to
    connect to the node through the forwarded port. Returns (http_status,
    response_dict); the answer carries only success, latencyMs, error and the
    probed host and port."""
    if not isinstance(payload, dict) or set(payload.keys()) != {"nodePubkey"}:
        return 400, {"error": "Expected exactly one field: nodePubkey"}
    node_pubkey = payload["nodePubkey"]
    node_pubkey = node_pubkey.strip().lower() if isinstance(node_pubkey, str) else ""
    if not _NODE_PUBKEY_RE.match(node_pubkey):
        return 400, {"error": "nodePubkey must be a 66-character hex Lightning node public key"}
    host, port, reason = _reachability_target()
    if reason is not None:
        return 409, {"error": reason}

    with _reachability_lock:
        now = time.monotonic()
        while _reachability_calls and now - _reachability_calls[0] >= REACHABILITY_WINDOW:
            _reachability_calls.popleft()
        if len(_reachability_calls) >= REACHABILITY_LIMIT:
            retry_after = max(1, math.ceil(REACHABILITY_WINDOW - (now - _reachability_calls[0])))
            return 429, {"error": f"Please wait {retry_after}s before checking again.", "retryAfterSeconds": retry_after}
        _reachability_calls.append(now)

    unavailable = (502, {"error": "The TunnelSats check service did not answer. Please try again later."})
    req = urllib.request.Request(
        f"{TUNNELSATS_API_URL}/ping/test",
        data=json.dumps({"socket": f"{node_pubkey}@{host}:{port}"}).encode("utf-8"),
        headers={"Content-Type": "application/json", "User-Agent": f"TunnelSats-StartOS/{get_package_version()}"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=REACHABILITY_TIMEOUT) as response:
            data = json.loads(response.read(REACHABILITY_MAX_RESPONSE_BYTES).decode("utf-8"))
    except urllib.error.HTTPError as e:
        if e.code == 429:
            return 429, {"error": "The TunnelSats check service is busy. Please wait a minute.",
                         "retryAfterSeconds": 60}
        print(f"Reachability check: HTTP {e.code} from the TunnelSats API", file=sys.stderr)
        return unavailable
    except Exception as e:
        print(f"Reachability check failed: {e}", file=sys.stderr)
        return unavailable
    if not isinstance(data, dict):
        return unavailable

    success = data.get("success") is True
    latency = data.get("latencyMs")
    if isinstance(latency, bool) or not isinstance(latency, (int, float)) or not math.isfinite(latency) \
            or not 0 <= latency <= REACHABILITY_MAX_LATENCY_MS:
        latency = None
    error = None if success else (
        _dashboard_text(data.get("error"), 200) or "The node did not answer through the forwarded port."
    )
    return 200, {"success": success, "latencyMs": latency, "error": error, "host": host, "port": port}


def confirmed_bandwidth_limit(meta, public_key):
    """The monthly limit the API confirmed for public_key, else the default."""
    if public_key and meta.get("publicKey") == public_key:
        limit = valid_bandwidth_limit(meta.get("bandwidth_limit_gb"))
        if limit is not None:
            return limit
    return BANDWIDTH_LIMIT_GB


def _bandwidth_summary(meta, public_key, now):
    """Usage and reset quota for the current key. Usage and the resets used
    reset on the 1st (UTC), so they are shown only from a sync in the
    current UTC month; the limit and the allowance are not monthly."""
    same_key = public_key is not None and meta.get("publicKey") == public_key
    synced = _parse_iso(meta.get("lastSync")) if same_key else None
    synced = synced.astimezone(timezone.utc) if synced is not None else None
    this_month = synced is not None and (synced.year, synced.month) == (now.year, now.month)
    return {
        "usedGb": _dashboard_amount(meta.get("bandwidth_used_gb")) if this_month else None,
        "limitGb": confirmed_bandwidth_limit(meta, public_key),
        "resetsThisMonth": valid_reset_count(meta.get("bandwidth_resets_this_month")) if this_month else None,
        "maxResetsPerMonth": valid_reset_count(meta.get("max_resets_per_month")) if same_key else None,
        "resetThresholdPct": RESET_THRESHOLD_DEFAULT_PCT,
    }


_NWC_DEFAULT_ESTIMATED_SATS = {1: 4500, 3: 12000, 6: 22500, 12: 42000}


def _nwc_recommended_budget(resolved_months, last_amount_sats=None, last_months=1):
    if (
        isinstance(last_amount_sats, (int, float))
        and not isinstance(last_amount_sats, bool)
        and math.isfinite(last_amount_sats)
        and last_amount_sats > 0
    ):
        if not last_months or last_months == resolved_months:
            estimated_sats = max(1, round(last_amount_sats))
        else:
            estimated_sats = max(1, math.ceil((last_amount_sats / last_months) * resolved_months))
    else:
        estimated_sats = _NWC_DEFAULT_ESTIMATED_SATS.get(resolved_months, 4500)
    recommended_sats = math.ceil(estimated_sats * 1.2)
    annual_sats = math.ceil((12 / resolved_months) * estimated_sats * 1.2)
    return {
        "estimatedRenewalSats": estimated_sats,
        "recommendedBudgetSats": recommended_sats,
        "recommendedAnnualSats": annual_sats,
    }


def _nwc_period_advanced(period_expiry_iso, current_expiry_iso):
    """True only when the confirmed expiry strictly advanced past periodExpiry
    (indicating a completed renewal into a new period, rather than a server-side
    shortening or timestamp format difference)."""
    p_dt = _parse_iso(period_expiry_iso)
    c_dt = _parse_iso(current_expiry_iso)
    if p_dt is None or c_dt is None:
        return False
    return c_dt > p_dt


def _is_current_nwc_period_failure(meta, state):
    if not isinstance(state, dict):
        return False
    if not state.get("fallbackTaskRaised") and not state.get("budgetWarning") and not state.get("lastError"):
        return False
    if _nwc_period_advanced(state.get("periodExpiry"), meta.get("expiresAt")):
        return False
    return True


def _nwc_summary(meta):
    """Read-only NWC auto-renewal status for the dashboard. Derived strictly
    from tunnelsats-meta.json (never reads /data/nwc-wallet.json or exposes
    the nostr+walletconnect:// URI or secret)."""
    connected = meta.get("nwcConnected") is True
    duration_setting = meta.get("nwcAutoRenewDuration")
    if duration_setting not in ("match", "1m", "3m", "6m", "12m"):
        duration_setting = "match"
    last_duration = _dashboard_duration(meta.get("lastDuration"))
    resolved_duration = (last_duration or "1m") if duration_setting == "match" else duration_setting
    resolved_months = int(resolved_duration[:-1])
    last_amount = _dashboard_amount(meta.get("lastAmountSats"))
    last_months = int(last_duration[:-1]) if last_duration else 1
    recommended = _nwc_recommended_budget(resolved_months, last_amount, last_months)
    state = meta.get("nwcAutoRenewState") if isinstance(meta.get("nwcAutoRenewState"), dict) else {}
    restore_needed = bool(state.get("restoreReconnectNeeded")) if connected else False
    period_fail = connected and _is_current_nwc_period_failure(meta, state)
    return {
        "connected": connected,
        "relayHost": _dashboard_text(meta.get("nwcRelayHost"), 253) if connected else None,
        "routeViaTor": bool(meta.get("nwcRouteViaTor")) if connected else False,
        "autoRenewDuration": duration_setting,
        "resolvedDuration": resolved_duration,
        "resolvedDurationMonths": resolved_months,
        "recommendedBudgetSats": recommended["recommendedBudgetSats"],
        "recommendedAnnualSats": recommended["recommendedAnnualSats"],
        "budgetWarning": bool(state.get("budgetWarning")) if period_fail else False,
        "fallbackTaskRaised": bool(state.get("fallbackTaskRaised")) if period_fail else False,
        "restoreReconnectNeeded": restore_needed,
        "lastError": _dashboard_error_text(state.get("lastError")) if (period_fail or restore_needed) else None,
        "lastPaidAt": _dashboard_time(state.get("lastPaidAt")) if connected else None,
        "lastPaidDuration": _dashboard_duration(state.get("lastPaidDuration")) if connected else None,
        "lastPaidAmountSats": _dashboard_amount(state.get("lastPaidAmountSats")) if connected else None,
    }


# ─── NIP-47 NWC Auto-Renew Engine ────────────────────────────────────────────
# Executes automatic subscription renewals via Nostr Wallet Connect (NIP-47).
# Secret material lives exclusively in /data/nwc-wallet.json (mode 0600,
# excluded from StartOS backups) and is never written to tunnelsats-meta.json
# or logged.

NWC_MAX_RENEWAL_SATS = 500_000
NWC_MAX_ATTEMPTS = 3
NWC_RETRY_DELAY = timedelta(hours=1)
NWC_TRIGGER_WINDOW = timedelta(days=7)
NWC_GRACE_WINDOW = timedelta(days=7)
TOR_SOCKS_HOST = os.getenv("TOR_SOCKS_HOST", "tor.embassy")
TOR_SOCKS_PORT = int(os.getenv("TOR_SOCKS_PORT", "9050"))

_NWC_PUBKEY_RE = re.compile(r"^[0-9a-f]{64}$")
_NWC_PERMANENT_ERROR_CODES = frozenset({
    "QUOTA_EXCEEDED",
    "INSUFFICIENT_BALANCE",
    "UNAUTHORIZED",
    "RESTRICTED",
    "NOT_IMPLEMENTED",
})
_NWC_BUDGET_ERROR_CODES = frozenset({"QUOTA_EXCEEDED", "INSUFFICIENT_BALANCE"})
_BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"
_BECH32_CHARSET_MAP = {c: i for i, c in enumerate(_BECH32_CHARSET)}


class NwcError(Exception):
    def __init__(self, message, code="INTERNAL", permanent=False, budget=False):
        super().__init__(message)
        self.code = code
        self.permanent = permanent
        self.budget = budget


class NwcVerificationError(NwcError):
    def __init__(self, message):
        super().__init__(message, code="VERIFICATION_FAILED", permanent=True, budget=False)


def _redact_nwc_secrets(text, secret=None):
    if not isinstance(text, str):
        return "NWC operation failed"
    cleaned = re.sub(r"nostr(?:\+walletconnect|walletconnect)://\S+", "[redacted-nwc-uri]", text, flags=re.IGNORECASE)
    if isinstance(secret, str) and len(secret) >= 8:
        cleaned = cleaned.replace(secret, "[redacted]")
        cleaned = cleaned.replace(secret.lower(), "[redacted]")
    cleaned = _HEX64_RE.sub("[redacted]", cleaned)
    return cleaned[:240]


def parse_nwc_uri(raw_input):
    """Validates a nostr+walletconnect:// URI and returns its parsed fields.
    Raises ValueError with a secret-free message on invalid input."""
    if not isinstance(raw_input, str) or not raw_input.strip():
        raise ValueError("NWC Connection URI must not be empty.")
    trimmed = raw_input.strip()
    lower = trimmed.lower()
    if lower.startswith("nostr+walletconnect://"):
        rest = trimmed[len("nostr+walletconnect://"):]
    elif lower.startswith("nostrwalletconnect://"):
        rest = trimmed[len("nostrwalletconnect://"):]
    else:
        raise ValueError("NWC Connection URI must start with nostr+walletconnect://")

    pubkey_part, sep, query_part = rest.partition("?")
    wallet_pubkey = pubkey_part.strip().rstrip("/").lower()
    if not _NWC_PUBKEY_RE.match(wallet_pubkey):
        raise ValueError("NWC Connection URI must contain a 64-character hex wallet pubkey.")
    if not sep or not query_part:
        raise ValueError("NWC Connection URI is missing query parameters (?relay=...&secret=...).")

    from urllib.parse import parse_qsl, urlparse, quote
    params = parse_qsl(query_part, keep_blank_values=True)
    raw_relays = [v.strip() for k, v in params if k == "relay" and v.strip()]
    if not raw_relays:
        raise ValueError("NWC Connection URI must include at least one relay= parameter.")

    relays = []
    relay_hosts = []
    has_onion_relay = False
    for raw_relay in raw_relays:
        parsed_relay = urlparse(raw_relay)
        scheme = (parsed_relay.scheme or "").lower()
        hostname = (parsed_relay.hostname or "").lower()
        if not hostname:
            raise ValueError("Invalid relay URL in NWC Connection URI.")
        is_onion = hostname.endswith(".onion")
        if scheme == "ws":
            if not is_onion:
                raise ValueError(f"Plaintext ws:// relay ({hostname}) is only allowed for .onion hidden services.")
        elif scheme != "wss":
            raise ValueError(f"Relay URL ({hostname}) must use wss:// (or ws:// for .onion).")
        try:
            port = parsed_relay.port
        except ValueError:
            raise ValueError(f"Invalid port in relay URL ({hostname}).")
        if is_onion:
            has_onion_relay = True
        host_literal = f"[{hostname}]" if ":" in hostname else hostname
        path = parsed_relay.path if parsed_relay.path and parsed_relay.path != "/" else ""
        query_suffix = f"?{parsed_relay.query}" if parsed_relay.query else ""
        if query_suffix and not path:
            path = "/"
        port_suffix = f":{port}" if port else ""
        normalized_relay = f"{scheme}://{host_literal}{port_suffix}{path}{query_suffix}"
        if normalized_relay not in relays:
            relays.append(normalized_relay)
        if host_literal not in relay_hosts:
            relay_hosts.append(host_literal)

    secrets_list = [v.strip().lower() for k, v in params if k == "secret" and v.strip()]
    if not secrets_list:
        raise ValueError("NWC Connection URI is missing the secret= parameter.")
    secret = secrets_list[0]
    if not _NWC_PUBKEY_RE.match(secret):
        raise ValueError("NWC Connection URI secret must be a 64-character hex string.")

    relay_query = "&".join(f"relay={quote(r, safe='')}" for r in relays)
    normalized_uri = f"nostr+walletconnect://{wallet_pubkey}?{relay_query}&secret={secret}"
    return {
        "uri": normalized_uri,
        "walletPubkey": wallet_pubkey,
        "relays": relays,
        "relayHost": relay_hosts[0],
        "secret": secret,
        "hasOnionRelay": has_onion_relay,
    }


def _bech32_polymod(values):
    gen = (0x3B6A57B2, 0x26508E6D, 0x1EA119FA, 0x3D4233DD, 0x2A1462B3)
    chk = 1
    for v in values:
        b = chk >> 25
        chk = ((chk & 0x1FFFFFF) << 5) ^ v
        for i in range(5):
            if (b >> i) & 1:
                chk ^= gen[i]
    return chk


def _bech32_hrp_expand(hrp):
    return [ord(x) >> 5 for x in hrp] + [0] + [ord(x) & 31 for x in hrp]


def _bech32_verify_checksum(hrp, data):
    return _bech32_polymod(_bech32_hrp_expand(hrp) + data) == 1


def _verify_bolt11_invoice(bolt11, expected_payment_hash, max_sats=NWC_MAX_RENEWAL_SATS):
    """Verifies a BOLT11 invoice in pure Python before paying via NWC:
    1. Valid BOLT11 HRP and Bech32 checksum.
    2. Positive satoshi amount <= max_sats (500,000 sats).
    3. Embedded tagged field 'p' (type 1, length 52 words = 256-bit hash)
       matches expected_payment_hash.
    Returns the verified amount in satoshis or raises NwcVerificationError."""
    if not isinstance(bolt11, str) or not bolt11.strip():
        raise NwcVerificationError("Renewal invoice is empty or missing.")
    if not isinstance(expected_payment_hash, str) or not _NWC_PUBKEY_RE.match(expected_payment_hash.lower()):
        raise NwcVerificationError("Expected payment hash is invalid.")
    inv = bolt11.strip().lower()
    amount_sats = _bolt11_amount_sats(inv)
    if amount_sats is None or amount_sats <= 0:
        raise NwcVerificationError("Renewal invoice does not specify a valid positive satoshi amount.")
    if amount_sats > max_sats:
        raise NwcVerificationError(
            f"Renewal invoice amount ({amount_sats} sats) exceeds the NWC safety ceiling ({max_sats} sats)."
        )
    sep = inv.rfind("1")
    if sep < 4:
        raise NwcVerificationError("Renewal invoice is missing the Bech32 separator.")
    hrp = inv[:sep]
    data_part = inv[sep + 1:]
    # 7 words timestamp + 104 words signature + 6 words checksum = 117 words minimum
    if len(data_part) < 117:
        raise NwcVerificationError("Renewal invoice data section is too short.")
    try:
        words = [_BECH32_CHARSET_MAP[c] for c in data_part]
    except KeyError:
        raise NwcVerificationError("Renewal invoice contains invalid Bech32 characters.")
    if not _bech32_verify_checksum(hrp, words):
        raise NwcVerificationError("Renewal invoice Bech32 checksum verification failed.")

    tagged = words[7 : len(words) - 110]
    idx = 0
    embedded_hash = None
    while idx + 3 <= len(tagged):
        tag_type = tagged[idx]
        data_len = (tagged[idx + 1] << 5) | tagged[idx + 2]
        idx += 3
        if idx + data_len > len(tagged):
            raise NwcVerificationError("Renewal invoice has truncated BOLT11 tagged field.")
        field_words = tagged[idx : idx + data_len]
        idx += data_len
        # Tag 'p' is index 1 in Bech32 charset ("qpzry9...") and holds 52 5-bit words (256 bits + 4 zero pad bits)
        if tag_type == 1 and data_len == 52 and embedded_hash is None:
            acc = 0
            for w in field_words:
                acc = (acc << 5) | w
            embedded_hash = (acc >> 4).to_bytes(32, "big").hex()

    if embedded_hash is None:
        raise NwcVerificationError("Renewal invoice does not contain a BOLT11 payment hash ('p' tag).")
    if embedded_hash != expected_payment_hash.lower():
        raise NwcVerificationError("Renewal invoice payment hash does not match the TunnelSats renewal paymentHash.")
    return amount_sats


# ─── Pure-Python secp256k1 / BIP-340 Schnorr / NIP-04 Crypto ─────────────────

_SECP_P = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2F
_SECP_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141
_SECP_GX = 0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798
_SECP_GY = 0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8
_SECP_G = (_SECP_GX, _SECP_GY)


def _secp_point_add(p1, p2):
    if p1 is None:
        return p2
    if p2 is None:
        return p1
    x1, y1 = p1
    x2, y2 = p2
    if x1 == x2 and y1 != y2:
        return None
    if x1 == x2:
        lam = (3 * x1 * x1 * pow(2 * y1, _SECP_P - 2, _SECP_P)) % _SECP_P
    else:
        lam = ((y2 - y1) * pow(x2 - x1, _SECP_P - 2, _SECP_P)) % _SECP_P
    x3 = (lam * lam - x1 - x2) % _SECP_P
    y3 = (lam * (x1 - x3) - y1) % _SECP_P
    return (x3, y3)


def _secp_point_mul(k, point=_SECP_G):
    if k <= 0 or k >= _SECP_N:
        raise ValueError("Invalid secp256k1 scalar")
    result = None
    addend = point
    while k:
        if k & 1:
            result = _secp_point_add(result, addend)
        addend = _secp_point_add(addend, addend)
        k >>= 1
    return result


def _secp_lift_x(x):
    if x <= 0 or x >= _SECP_P:
        raise ValueError("Invalid x-only public key coordinate")
    c = (pow(x, 3, _SECP_P) + 7) % _SECP_P
    y = pow(c, (_SECP_P + 1) // 4, _SECP_P)
    if pow(y, 2, _SECP_P) != c:
        raise ValueError("Point is not on secp256k1 curve")
    return (x, y if y % 2 == 0 else _SECP_P - y)


def _tagged_hash(tag, msg_bytes):
    import hashlib
    tag_hash = hashlib.sha256(tag.encode("utf-8")).digest()
    return hashlib.sha256(tag_hash + tag_hash + msg_bytes).digest()


def _nostr_pubkey_from_secret(secret_hex):
    d = int(secret_hex, 16)
    pt = _secp_point_mul(d)
    return pt[0].to_bytes(32, "big").hex()


def _schnorr_sign(secret_hex, msg_bytes):
    if len(msg_bytes) != 32:
        raise ValueError("BIP-340 message must be 32 bytes")
    d0 = int(secret_hex, 16)
    P = _secp_point_mul(d0)
    d = d0 if (P[1] % 2 == 0) else (_SECP_N - d0)
    px_bytes = P[0].to_bytes(32, "big")
    aux = _tagged_hash("BIP0340/aux", os.urandom(32))
    t = (d ^ int.from_bytes(aux, "big")).to_bytes(32, "big")
    k0 = int.from_bytes(_tagged_hash("BIP0340/nonce", t + px_bytes + msg_bytes), "big") % _SECP_N
    if k0 == 0:
        raise ValueError("Invalid Schnorr nonce")
    R = _secp_point_mul(k0)
    k = k0 if (R[1] % 2 == 0) else (_SECP_N - k0)
    rx_bytes = R[0].to_bytes(32, "big")
    e = int.from_bytes(_tagged_hash("BIP0340/challenge", rx_bytes + px_bytes + msg_bytes), "big") % _SECP_N
    s = (k + e * d) % _SECP_N
    return (rx_bytes + s.to_bytes(32, "big")).hex()


def _schnorr_verify(pubkey_hex, msg_bytes, sig_hex):
    try:
        if len(msg_bytes) != 32 or len(sig_hex) != 128:
            return False
        P = _secp_lift_x(int(pubkey_hex, 16))
        sig_bytes = bytes.fromhex(sig_hex)
        r = int.from_bytes(sig_bytes[:32], "big")
        s = int.from_bytes(sig_bytes[32:], "big")
        if r >= _SECP_P or s >= _SECP_N:
            return False
        e = int.from_bytes(
            _tagged_hash("BIP0340/challenge", sig_bytes[:32] + P[0].to_bytes(32, "big") + msg_bytes),
            "big",
        ) % _SECP_N
        R = _secp_point_add(_secp_point_mul(s), _secp_point_mul(_SECP_N - e, P)) if e != 0 else _secp_point_mul(s)
        if R is None or R[1] % 2 != 0 or R[0] != r:
            return False
        return True
    except Exception:
        return False


def _nip04_shared_secret(secret_hex, peer_pubkey_hex):
    d = int(secret_hex, 16)
    W = _secp_lift_x(int(peer_pubkey_hex, 16))
    S = _secp_point_mul(d, W)
    return S[0].to_bytes(32, "big")


def _aes_xtime(a):
    return (((a << 1) ^ 0x11B) & 0xFF) if (a & 0x80) else (a << 1)


def _aes_gf_mul(a, b):
    res = 0
    for _ in range(8):
        if b & 1:
            res ^= a
        a = _aes_xtime(a)
        b >>= 1
    return res


def _build_aes_sboxes():
    sbox = [0] * 256
    inv_sbox = [0] * 256
    for x in range(256):
        # Multiplicative inverse in GF(2^8): x^254 (0 maps to 0)
        inv = 0
        if x != 0:
            inv = 1
            base = x
            exp = 254
            while exp:
                if exp & 1:
                    inv = _aes_gf_mul(inv, base)
                base = _aes_gf_mul(base, base)
                exp >>= 1
        s = inv
        for _ in range(4):
            s = ((s << 1) | (s >> 7)) & 0xFF
            inv ^= s
        val = (inv ^ 0x63) & 0xFF
        sbox[x] = val
        inv_sbox[val] = x
    return bytes(sbox), bytes(inv_sbox)


_AES_SBOX, _AES_INV_SBOX = _build_aes_sboxes()
_AES_SHIFT_ROWS = (0, 5, 10, 15, 4, 9, 14, 3, 8, 13, 2, 7, 12, 1, 6, 11)
_AES_INV_SHIFT_ROWS = (0, 13, 10, 7, 4, 1, 14, 11, 8, 5, 2, 15, 12, 9, 6, 3)


def _aes256_expand_key(key32):
    if len(key32) != 32:
        raise ValueError("AES-256 key must be 32 bytes")
    w = [int.from_bytes(key32[4 * i : 4 * (i + 1)], "big") for i in range(8)]
    rcon = 1
    for i in range(8, 60):
        temp = w[i - 1]
        if i % 8 == 0:
            temp = ((temp << 8) | (temp >> 24)) & 0xFFFFFFFF
            temp = (
                (_AES_SBOX[(temp >> 24) & 0xFF] << 24)
                | (_AES_SBOX[(temp >> 16) & 0xFF] << 16)
                | (_AES_SBOX[(temp >> 8) & 0xFF] << 8)
                | _AES_SBOX[temp & 0xFF]
            ) ^ (rcon << 24)
            rcon = _aes_xtime(rcon)
        elif i % 8 == 4:
            temp = (
                (_AES_SBOX[(temp >> 24) & 0xFF] << 24)
                | (_AES_SBOX[(temp >> 16) & 0xFF] << 16)
                | (_AES_SBOX[(temp >> 8) & 0xFF] << 8)
                | _AES_SBOX[temp & 0xFF]
            )
        w.append(w[i - 8] ^ temp)
    round_keys = []
    for r in range(15):
        rk = bytearray(16)
        for c in range(4):
            rk[4 * c : 4 * (c + 1)] = w[4 * r + c].to_bytes(4, "big")
        round_keys.append(bytes(rk))
    return round_keys


def _aes256_encrypt_block(block16, round_keys):
    rk0 = round_keys[0]
    s = [block16[i] ^ rk0[i] for i in range(16)]
    for r in range(1, 14):
        s = [_AES_SBOX[s[i]] for i in _AES_SHIFT_ROWS]
        rk = round_keys[r]
        for c in range(0, 16, 4):
            a0, a1, a2, a3 = s[c], s[c + 1], s[c + 2], s[c + 3]
            t = a0 ^ a1 ^ a2 ^ a3
            s[c] = a0 ^ t ^ _aes_xtime(a0 ^ a1) ^ rk[c]
            s[c + 1] = a1 ^ t ^ _aes_xtime(a1 ^ a2) ^ rk[c + 1]
            s[c + 2] = a2 ^ t ^ _aes_xtime(a2 ^ a3) ^ rk[c + 2]
            s[c + 3] = a3 ^ t ^ _aes_xtime(a3 ^ a0) ^ rk[c + 3]
    rk14 = round_keys[14]
    return bytes(_AES_SBOX[s[_AES_SHIFT_ROWS[i]]] ^ rk14[i] for i in range(16))


def _aes256_decrypt_block(block16, round_keys):
    rk14 = round_keys[14]
    s = [block16[i] ^ rk14[i] for i in range(16)]
    for r in range(13, 0, -1):
        rk = round_keys[r]
        s = [_AES_INV_SBOX[s[_AES_INV_SHIFT_ROWS[i]]] ^ rk[i] for i in range(16)]
        for c in range(0, 16, 4):
            a0, a1, a2, a3 = s[c], s[c + 1], s[c + 2], s[c + 3]
            u = _aes_xtime(_aes_xtime(a0 ^ a2))
            v = _aes_xtime(_aes_xtime(a1 ^ a3))
            b0, b1, b2, b3 = a0 ^ u, a1 ^ v, a2 ^ u, a3 ^ v
            t = b0 ^ b1 ^ b2 ^ b3
            s[c] = b0 ^ t ^ _aes_xtime(b0 ^ b1)
            s[c + 1] = b1 ^ t ^ _aes_xtime(b1 ^ b2)
            s[c + 2] = b2 ^ t ^ _aes_xtime(b2 ^ b3)
            s[c + 3] = b3 ^ t ^ _aes_xtime(b3 ^ b0)
    rk0 = round_keys[0]
    return bytes(_AES_INV_SBOX[s[_AES_INV_SHIFT_ROWS[i]]] ^ rk0[i] for i in range(16))


def _nip04_encrypt(shared_key_bytes, plaintext):
    import base64
    iv = os.urandom(16)
    raw = plaintext.encode("utf-8")
    pad_len = 16 - (len(raw) % 16)
    padded = raw + bytes([pad_len] * pad_len)
    round_keys = _aes256_expand_key(shared_key_bytes)
    out = bytearray()
    prev = iv
    for offset in range(0, len(padded), 16):
        blk = bytes(padded[offset + i] ^ prev[i] for i in range(16))
        prev = _aes256_encrypt_block(blk, round_keys)
        out.extend(prev)
    return f"{base64.b64encode(bytes(out)).decode('ascii')}?iv={base64.b64encode(iv).decode('ascii')}"


def _nip04_decrypt(shared_key_bytes, content):
    import base64
    if not isinstance(content, str) or "?iv=" not in content:
        raise ValueError("Invalid NIP-04 encrypted content")
    ct_b64, _, iv_b64 = content.partition("?iv=")
    ciphertext = base64.b64decode(ct_b64)
    iv = base64.b64decode(iv_b64)
    if len(iv) != 16 or len(ciphertext) == 0 or len(ciphertext) % 16 != 0:
        raise ValueError("Invalid NIP-04 ciphertext or IV length")
    round_keys = _aes256_expand_key(shared_key_bytes)
    padded = bytearray()
    prev = iv
    for offset in range(0, len(ciphertext), 16):
        ct_blk = ciphertext[offset : offset + 16]
        dec_blk = _aes256_decrypt_block(ct_blk, round_keys)
        padded.extend(dec_blk[i] ^ prev[i] for i in range(16))
        prev = ct_blk
    pad_len = padded[-1]
    if pad_len < 1 or pad_len > 16 or bytes(padded[-pad_len:]) != bytes([pad_len] * pad_len):
        raise ValueError("Invalid NIP-04 PKCS#7 padding")
    return bytes(padded[:-pad_len]).decode("utf-8")


def _build_nip47_request_event(secret_hex, wallet_pubkey_hex, method, params, created_at=None):
    import hashlib
    client_pubkey = _nostr_pubkey_from_secret(secret_hex)
    shared_key = _nip04_shared_secret(secret_hex, wallet_pubkey_hex)
    payload_str = json.dumps({"method": method, "params": params}, separators=(",", ":"))
    content = _nip04_encrypt(shared_key, payload_str)
    ts = int(created_at if created_at is not None else time.time())
    tags = [["p", wallet_pubkey_hex]]
    commitment = json.dumps([0, client_pubkey, ts, 23194, tags, content], separators=(",", ":"), ensure_ascii=False)
    event_id_bytes = hashlib.sha256(commitment.encode("utf-8")).digest()
    sig = _schnorr_sign(secret_hex, event_id_bytes)
    return {
        "id": event_id_bytes.hex(),
        "pubkey": client_pubkey,
        "created_at": ts,
        "kind": 23194,
        "tags": tags,
        "content": content,
        "sig": sig,
    }, shared_key


def _parse_nip47_response_event(resp_event, request_event_id, wallet_pubkey_hex, shared_key):
    import hashlib
    if not isinstance(resp_event, dict):
        raise ValueError("Invalid Nostr event object")
    if resp_event.get("kind") != 23195:
        raise ValueError("Unexpected Nostr event kind")
    if str(resp_event.get("pubkey") or "").lower() != wallet_pubkey_hex.lower():
        raise ValueError("Response event pubkey does not match wallet pubkey")
    tags = resp_event.get("tags")
    if not isinstance(tags, list):
        raise ValueError("Response event has invalid tags")
    e_tags = [t[1] for t in tags if isinstance(t, list) and len(t) >= 2 and t[0] == "e"]
    if request_event_id not in e_tags:
        raise ValueError("Response event does not reference our request event ID")
    commitment = json.dumps(
        [
            0,
            resp_event.get("pubkey"),
            resp_event.get("created_at"),
            resp_event.get("kind"),
            tags,
            resp_event.get("content"),
        ],
        separators=(",", ":"),
        ensure_ascii=False,
    )
    expected_id_bytes = hashlib.sha256(commitment.encode("utf-8")).digest()
    if resp_event.get("id") != expected_id_bytes.hex():
        raise ValueError("Response event ID does not match commitment hash")
    if not _schnorr_verify(wallet_pubkey_hex, expected_id_bytes, str(resp_event.get("sig") or "")):
        raise ValueError("Response event Schnorr signature verification failed")
    decrypted = _nip04_decrypt(shared_key, resp_event.get("content"))
    body = json.loads(decrypted)
    if not isinstance(body, dict):
        raise ValueError("Decrypted NIP-47 response is not a JSON object")
    return body


# ─── Minimal RFC 6455 WebSocket + SOCKS5h Client ─────────────────────────────

def _recv_exact(sock, length, deadline=None):
    buf = bytearray()
    while len(buf) < length:
        if deadline is not None:
            rem = deadline - time.monotonic()
            if rem <= 0:
                raise TimeoutError("Timed out reading from NWC relay")
            sock.settimeout(min(rem, 15.0))
        chunk = sock.recv(length - len(buf))
        if not chunk:
            raise ConnectionError("Socket closed prematurely")
        buf.extend(chunk)
    return bytes(buf)


def _connect_socks5h(target_host, target_port, timeout=15):
    """Connects to (target_host, target_port) through the local Tor SOCKS5h
    proxy (ATYP=0x03 domain name resolution on the proxy). Fails closed if the
    SOCKS5 proxy is unreachable or rejects the connection."""
    host_bytes = target_host.encode("idna")
    if not (1 <= len(host_bytes) <= 255):
        raise NwcError("Invalid relay hostname for SOCKS5h proxy")
    deadline = time.monotonic() + timeout
    try:
        sock = socket.create_connection((TOR_SOCKS_HOST, TOR_SOCKS_PORT), timeout=timeout)
        sock.settimeout(timeout)
        # RFC 1928 Greeting: VER=5, NMETHODS=1, METHOD=0 (No Auth)
        sock.sendall(b"\x05\x01\x00")
        ver, method = _recv_exact(sock, 2, deadline=deadline)
        if ver != 5 or method != 0:
            sock.close()
            raise NwcError("Tor SOCKS5 proxy rejected authentication method")
        # CONNECT command with ATYP=3 (Domain Name -> SOCKS5h)
        req = (
            b"\x05\x01\x00\x03"
            + bytes([len(host_bytes)])
            + host_bytes
            + int(target_port).to_bytes(2, "big")
        )
        sock.sendall(req)
        ver, rep, _rsv, atyp = _recv_exact(sock, 4, deadline=deadline)
        if ver != 5 or rep != 0:
            sock.close()
            raise NwcError(f"Tor SOCKS5 proxy could not connect to relay (SOCKS code {rep})")
        if atyp == 1:
            _recv_exact(sock, 4 + 2, deadline=deadline)
        elif atyp == 3:
            addr_len = _recv_exact(sock, 1, deadline=deadline)[0]
            _recv_exact(sock, addr_len + 2, deadline=deadline)
        elif atyp == 4:
            _recv_exact(sock, 16 + 2, deadline=deadline)
        else:
            sock.close()
            raise NwcError("Tor SOCKS5 proxy returned unknown address type")
        return sock
    except NwcError:
        raise
    except Exception as e:
        raise NwcError(f"Tor SOCKS5 proxy ({TOR_SOCKS_HOST}:{TOR_SOCKS_PORT}) connection failed: {e}")


def _ws_send_frame(sock, opcode, payload_bytes):
    mask_key = os.urandom(4)
    header = bytearray([0x80 | (opcode & 0x0F)])
    length = len(payload_bytes)
    if length < 126:
        header.append(0x80 | length)
    elif length < 65536:
        header.append(0x80 | 126)
        header.extend(length.to_bytes(2, "big"))
    else:
        header.append(0x80 | 127)
        header.extend(length.to_bytes(8, "big"))
    header.extend(mask_key)
    masked = bytes(b ^ mask_key[i & 3] for i, b in enumerate(payload_bytes))
    sock.sendall(bytes(header) + masked)


def _ws_read_single_frame(sock, max_bytes=262144, deadline=None):
    b0, b1 = _recv_exact(sock, 2, deadline=deadline)
    fin = bool(b0 & 0x80)
    opcode = b0 & 0x0F
    masked = bool(b1 & 0x80)
    length = b1 & 0x7F
    if length == 126:
        length = int.from_bytes(_recv_exact(sock, 2, deadline=deadline), "big")
    elif length == 127:
        length = int.from_bytes(_recv_exact(sock, 8, deadline=deadline), "big")
    if length > max_bytes:
        raise NwcError("Relay WebSocket frame exceeds size limit")
    mask_key = _recv_exact(sock, 4, deadline=deadline) if masked else None
    payload = _recv_exact(sock, length, deadline=deadline) if length > 0 else b""
    if mask_key:
        payload = bytes(b ^ mask_key[i & 3] for i, b in enumerate(payload))
    return fin, opcode, payload


def _ws_recv_frame(sock, max_bytes=262144, deadline=None):
    fin, opcode, payload = _ws_read_single_frame(sock, max_bytes=max_bytes, deadline=deadline)
    if fin or opcode >= 0x8:
        return opcode, payload
    if opcode == 0x0:
        raise NwcError("Unexpected WebSocket continuation frame without initial frame")
    assembled = bytearray(payload)
    while True:
        c_fin, c_opcode, c_payload = _ws_read_single_frame(sock, max_bytes=max_bytes, deadline=deadline)
        if c_opcode == 0x8:
            return 0x8, c_payload
        if c_opcode == 0x9:
            _ws_send_frame(sock, 0xA, c_payload)
            continue
        if c_opcode == 0xA:
            continue
        if c_opcode != 0x0:
            raise NwcError("Expected WebSocket continuation frame (opcode 0x0)")
        if len(assembled) + len(c_payload) > max_bytes:
            raise NwcError("Reassembled WebSocket message exceeds size limit")
        assembled.extend(c_payload)
        if c_fin:
            return opcode, bytes(assembled)


def _ws_open(relay_url, route_via_tor=False, timeout=15):
    import base64
    import hashlib
    import ssl
    from urllib.parse import urlparse

    parsed = urlparse(relay_url)
    scheme = (parsed.scheme or "").lower()
    hostname = (parsed.hostname or "").lower()
    is_onion = hostname.endswith(".onion")
    if scheme == "ws" and not is_onion:
        raise NwcError("Refusing plaintext ws:// connection to non-onion relay", permanent=True)
    port = parsed.port or (443 if scheme == "wss" else 80)
    path = parsed.path or "/"
    if parsed.query:
        path = f"{path}?{parsed.query}"

    deadline = time.monotonic() + timeout
    use_tor = bool(route_via_tor or is_onion)
    if use_tor:
        raw_sock = _connect_socks5h(hostname, port, timeout=timeout)
    else:
        try:
            raw_sock = socket.create_connection((hostname, port), timeout=timeout)
            raw_sock.settimeout(timeout)
        except Exception as e:
            raise NwcError(f"Could not connect to NWC relay {hostname}: {e}")

    sock = raw_sock
    try:
        if scheme == "wss":
            ctx = ssl.create_default_context()
            sock = ctx.wrap_socket(raw_sock, server_hostname=hostname)
            sock.settimeout(timeout)

        ws_key = base64.b64encode(os.urandom(16)).decode("ascii")
        default_port = (scheme == "wss" and port == 443) or (scheme == "ws" and port == 80)
        host_literal = f"[{hostname}]" if ":" in hostname else hostname
        host_hdr = host_literal if default_port else f"{host_literal}:{port}"
        handshake = (
            f"GET {path} HTTP/1.1\r\n"
            f"Host: {host_hdr}\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {ws_key}\r\n"
            "Sec-WebSocket-Version: 13\r\n"
            f"User-Agent: TunnelSats-StartOS/{get_package_version()}\r\n\r\n"
        )
        sock.sendall(handshake.encode("ascii"))

        resp_buf = bytearray()
        while b"\r\n\r\n" not in resp_buf:
            rem = deadline - time.monotonic()
            if rem <= 0:
                raise NwcError(f"Timed out waiting for WebSocket handshake from relay {hostname}")
            sock.settimeout(min(rem, 15.0))
            chunk = sock.recv(1)
            if not chunk:
                raise NwcError(f"Relay {hostname} closed connection during WebSocket handshake")
            resp_buf.extend(chunk)
            if len(resp_buf) > 16384:
                raise NwcError(f"Relay {hostname} sent oversized WebSocket handshake")

        header_text = resp_buf.decode("latin1", errors="replace")
        lines = header_text.split("\r\n")
        status_line = lines[0] if lines else ""
        if not status_line.startswith("HTTP/1.1 101"):
            raise NwcError(f"Relay {hostname} rejected WebSocket upgrade: {status_line[:80]}")
        expected_accept = base64.b64encode(
            hashlib.sha1((ws_key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode("ascii")).digest()
        ).decode("ascii")
        headers = {}
        for line in lines[1:]:
            if ":" in line:
                k, _, v = line.partition(":")
                headers[k.strip().lower()] = v.strip()
        if headers.get("sec-websocket-accept") != expected_accept:
            raise NwcError(f"Relay {hostname} returned invalid Sec-WebSocket-Accept")
        return sock
    except Exception:
        try:
            sock.close()
        except Exception:
            pass
        raise


def nwc_execute_command(parsed_uri, method, params, route_via_tor=False, timeout=20):
    """Executes a single NIP-47 command (e.g. get_budget, get_balance,
    lookup_invoice, pay_invoice) against the wallet's relays. Returns the
    NIP-47 `result` dict or raises NwcError."""
    import secrets
    req_event, shared_key = _build_nip47_request_event(
        parsed_uri["secret"],
        parsed_uri["walletPubkey"],
        method,
        params,
    )
    sub_id = f"ts-{secrets.token_hex(6)}"
    relays = parsed_uri.get("relays") or []
    last_err = None

    for relay_url in relays:
        sock = None
        try:
            sock = _ws_open(
                relay_url,
                route_via_tor=bool(route_via_tor or parsed_uri.get("hasOnionRelay")),
                timeout=timeout,
            )
            req_filter = {
                "kinds": [23195],
                "#e": [req_event["id"]],
                "authors": [parsed_uri["walletPubkey"]],
            }
            _ws_send_frame(sock, 0x1, json.dumps(["REQ", sub_id, req_filter]).encode("utf-8"))
            _ws_send_frame(sock, 0x1, json.dumps(["EVENT", req_event]).encode("utf-8"))

            deadline = time.monotonic() + timeout
            while time.monotonic() < deadline:
                opcode, payload = _ws_recv_frame(sock, deadline=deadline)
                if opcode == 0x8:  # Close
                    break
                if opcode == 0x9:  # Ping -> Pong
                    _ws_send_frame(sock, 0xA, payload)
                    continue
                if opcode != 0x1:
                    continue
                msg = json.loads(payload.decode("utf-8"))
                if not isinstance(msg, list) or len(msg) < 2:
                    continue
                if msg[0] == "OK" and len(msg) >= 3 and msg[1] == req_event["id"] and msg[2] is False:
                    reason = str(msg[3]) if len(msg) >= 4 else "Relay rejected request event"
                    raise NwcError(f"NWC relay rejected request: {reason}")
                if msg[0] == "EVENT" and len(msg) >= 3 and msg[1] == sub_id:
                    body = _parse_nip47_response_event(
                        msg[2],
                        req_event["id"],
                        parsed_uri["walletPubkey"],
                        shared_key,
                    )
                    err_obj = body.get("error")
                    if isinstance(err_obj, dict) and err_obj.get("code"):
                        code = str(err_obj.get("code")).upper()
                        err_msg = str(err_obj.get("message") or f"Wallet returned {code}")
                        raise NwcError(
                            _redact_nwc_secrets(err_msg, parsed_uri["secret"]),
                            code=code,
                            permanent=(code in _NWC_PERMANENT_ERROR_CODES),
                            budget=(code in _NWC_BUDGET_ERROR_CODES),
                        )
                    result = body.get("result")
                    if not isinstance(result, dict):
                        raise NwcError(f"Wallet returned an invalid or empty result for {method}")
                    if method == "pay_invoice":
                        preimage = result.get("preimage")
                        if not isinstance(preimage, str) or not preimage.strip():
                            raise NwcError("Wallet pay_invoice response did not include a payment preimage")
                    return result
            raise NwcError(f"Timed out waiting for NIP-47 {method} response from wallet")
        except NwcError as e:
            last_err = e
            if e.permanent or e.budget:
                raise
        except Exception as e:
            last_err = NwcError(_redact_nwc_secrets(str(e), parsed_uri.get("secret")))
        finally:
            if sock is not None:
                try:
                    _ws_send_frame(sock, 0x8, b"")
                except Exception:
                    pass
                try:
                    sock.close()
                except Exception:
                    pass

    if last_err is not None:
        raise last_err
    raise NwcError("No usable NWC relay available")


@contextmanager
def nwc_renew_lock():
    """Non-blocking cross-process lock around maybe_nwc_auto_renew so the
    background sync loop and the subscription health check never concurrently
    create or pay two renewal invoices."""
    fd = os.open(META_FILE_PATH + ".nwc.lock", os.O_RDWR | os.O_CREAT, 0o600)
    acquired = False
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            acquired = True
        except BlockingIOError:
            pass
        yield acquired
    finally:
        os.close(fd)


def _nwc_preflight_budget_check(parsed_uri, required_sats, route_via_tor=False):
    """Queries NIP-47 get_budget (and get_balance as a secondary check) before
    paying. Returns (ok: bool, error_code: str|None, message: str|None).
    Wallets that do not implement get_budget/get_balance are allowed to proceed
    to pay_invoice."""
    try:
        budget_res = nwc_execute_command(parsed_uri, "get_budget", {}, route_via_tor=route_via_tor, timeout=10)
        rem_msat = budget_res.get("remaining_budget")
        if isinstance(rem_msat, (int, float)) and not isinstance(rem_msat, bool) and rem_msat >= 0:
            rem_sats = int(rem_msat // 1000)
            if rem_sats < required_sats:
                return (
                    False,
                    "QUOTA_EXCEEDED",
                    f"NWC wallet remaining budget ({rem_sats} sats) is below the renewal invoice ({required_sats} sats).",
                )
    except NwcError:
        pass

    try:
        bal_res = nwc_execute_command(parsed_uri, "get_balance", {}, route_via_tor=route_via_tor, timeout=10)
        bal_msat = bal_res.get("balance")
        if isinstance(bal_msat, (int, float)) and not isinstance(bal_msat, bool) and bal_msat >= 0:
            bal_sats = int(bal_msat // 1000)
            if bal_sats < required_sats:
                return (
                    False,
                    "INSUFFICIENT_BALANCE",
                    f"NWC wallet balance ({bal_sats} sats) is below the renewal invoice ({required_sats} sats).",
                )
    except NwcError:
        pass

    return True, None, None


def _nwc_lookup_already_paid(parsed_uri, payment_hash, route_via_tor=False):
    """Asks the wallet via NIP-47 lookup_invoice whether payment_hash was
    already settled. Returns True only on a positive settled answer."""
    try:
        res = nwc_execute_command(
            parsed_uri,
            "lookup_invoice",
            {"payment_hash": payment_hash},
            route_via_tor=route_via_tor,
            timeout=10,
        )
        if not isinstance(res, dict):
            return False
        if res.get("settled_at") or res.get("preimage"):
            return True
        if str(res.get("state") or "").lower() == "settled":
            return True
    except NwcError:
        pass
    return False


def _record_nwc_failure(wg_pubkey, payment_hash, err, now, force_fallback=False, budget_warning=False):
    """Updates nwcAutoRenewState (and sets pendingRenewal.raisePayTask = True
    when tripping fallback on a saved pendingRenewal) under meta_lock."""
    with meta_lock():
        meta = read_meta()
        nwc_state = dict(meta.get("nwcAutoRenewState")) if isinstance(meta.get("nwcAutoRenewState"), dict) else {}
        current_exp = meta.get("expiresAt")
        if _nwc_period_advanced(nwc_state.get("periodExpiry"), current_exp):
            attempts = 1
        else:
            attempts = int(nwc_state.get("attempts") or 0) + 1
        trip_fallback = bool(
            force_fallback
            or budget_warning
            or attempts >= NWC_MAX_ATTEMPTS
        )
        if meta.get("nwcConnected") is True:
            nwc_state.update({
                "periodExpiry": current_exp,
                "attempts": attempts,
                "lastAttemptAt": _iso(now),
                "nextAttemptAt": None if trip_fallback else _iso(now + NWC_RETRY_DELAY),
                "lastError": _dashboard_error_text(str(err)),
                "lastErrorCode": getattr(err, "code", "INTERNAL"),
                "budgetWarning": bool(budget_warning),
                "fallbackTaskRaised": trip_fallback,
            })
            meta["nwcAutoRenewState"] = nwc_state
        pending = meta.get("pendingRenewal")
        if trip_fallback and payment_hash and isinstance(pending, dict) and pending.get("paymentHash") == payment_hash:
            pending["raisePayTask"] = True
        atomic_write_json(META_FILE_PATH, meta)
    return trip_fallback


def maybe_nwc_auto_renew(wg_pubkey, now=None):
    """Checks if the current subscription is within the NWC auto-renewal window
    (-7 days < remaining <= 7 days) and executes idempotent NIP-47 renewal.
    Serialized across processes via nwc_renew_lock()."""
    def _invoice_expiry(p):
        c = _parse_iso(p.get("createdAt"))
        return _parse_iso(p.get("expiresAt")) or (c + INVOICE_DEFAULT_TTL if c is not None else None)

    now = now or datetime.now(timezone.utc)
    if not wg_pubkey or wg_pubkey in ("Unknown", "Not available"):
        return {"result": "skipped", "message": "No configured WireGuard key."}

    with nwc_renew_lock() as acquired:
        if not acquired:
            return {"result": "busy", "message": "Another NWC auto-renewal check is already in progress."}

        with meta_lock():
            meta = read_meta()
            if meta.get("nwcConnected") is True and not os.path.exists(NWC_WALLET_FILE_PATH):
                nwc_state = dict(meta.get("nwcAutoRenewState")) if isinstance(meta.get("nwcAutoRenewState"), dict) else {}
                if nwc_state.get("restoreReconnectNeeded") is not True:
                    nwc_state["restoreReconnectNeeded"] = True
                    nwc_state["lastError"] = (
                        "NWC wallet credentials are not included in backups. Re-enter your NWC URI in Connect Wallet."
                    )
                    meta["nwcAutoRenewState"] = nwc_state
                    atomic_write_json(META_FILE_PATH, meta)
                return {"result": "restore-reconnect-needed", "message": "NWC wallet credentials missing after restore."}

            # Reset period-specific failure flags if confirmed expiresAt strictly advanced to a new period
            current_exp = meta.get("expiresAt")
            raw_state = meta.get("nwcAutoRenewState")
            if isinstance(raw_state, dict) and _nwc_period_advanced(raw_state.get("periodExpiry"), current_exp):
                cleaned_state = dict(raw_state)
                cleaned_state.update({
                    "periodExpiry": current_exp,
                    "attempts": 0,
                    "nextAttemptAt": None,
                    "lastError": None,
                    "lastErrorCode": None,
                    "budgetWarning": False,
                    "fallbackTaskRaised": False,
                })
                meta["nwcAutoRenewState"] = cleaned_state
                atomic_write_json(META_FILE_PATH, meta)

        if meta.get("nwcConnected") is not True or not os.path.exists(NWC_WALLET_FILE_PATH):
            return {"result": "disabled", "message": "NWC auto-renew is not enabled."}

        if meta.get("publicKey") != wg_pubkey or meta.get("expirySource") != "api":
            return {"result": "unconfirmed", "message": "Subscription expiry is not yet confirmed for this key."}

        expires_dt = _parse_iso(meta.get("expiresAt"))
        if expires_dt is None:
            return {"result": "unconfirmed", "message": "No valid confirmed expiry."}

        remaining = expires_dt - now
        if remaining > NWC_TRIGGER_WINDOW:
            return {"result": "not-due", "message": "Subscription has more than 7 days remaining."}
        if remaining <= -NWC_GRACE_WINDOW:
            return {"result": "past-grace", "message": "Subscription expired more than 7 days ago."}

        nwc_state = meta.get("nwcAutoRenewState") if isinstance(meta.get("nwcAutoRenewState"), dict) else {}
        if nwc_state.get("fallbackTaskRaised") is True or nwc_state.get("budgetWarning") is True:
            return {"result": "fallback-active", "message": "Fallback manual renewal is active."}

        next_attempt_dt = _parse_iso(nwc_state.get("nextAttemptAt"))
        if next_attempt_dt is not None and now < next_attempt_dt:
            return {"result": "backoff", "message": f"Waiting until {_iso(next_attempt_dt)} before next NWC retry."}

        wallet_doc = _read_json_object(NWC_WALLET_FILE_PATH)
        if not isinstance(wallet_doc, dict) or not isinstance(wallet_doc.get("uri"), str):
            err = NwcError("Stored NWC wallet file is unreadable or malformed", code="UNAUTHORIZED", permanent=True)
            _record_nwc_failure(wg_pubkey, None, err, now, force_fallback=True)
            return {"result": "failed", "message": str(err)}

        try:
            parsed_uri = parse_nwc_uri(wallet_doc["uri"])
        except ValueError as e:
            err = NwcError(str(e), code="UNAUTHORIZED", permanent=True)
            _record_nwc_failure(wg_pubkey, None, err, now, force_fallback=True)
            return {"result": "failed", "message": str(err)}

        route_via_tor = bool(
            wallet_doc.get("routeViaTor")
            or meta.get("nwcRouteViaTor")
            or parsed_uri.get("hasOnionRelay")
        )
        duration_setting = wallet_doc.get("autoRenewDuration") or meta.get("nwcAutoRenewDuration") or "match"
        if duration_setting not in ("match", "1m", "3m", "6m", "12m"):
            duration_setting = "match"
        last_dur = _dashboard_duration(meta.get("lastDuration")) or "1m"
        resolved_duration = last_dur if duration_setting == "match" else duration_setting
        months = int(resolved_duration[:-1])

        # Check if there is already a pendingRenewal for this key
        pending = meta.get("pendingRenewal")
        reusable_pending = None
        stale_hash = None
        stale_node = None
        
        if (
            isinstance(pending, dict)
            and pending.get("publicKey") == wg_pubkey
            and isinstance(pending.get("paymentHash"), str)
            and pending.get("paymentHash")
        ):
            payment_hash = pending["paymentHash"]
            if pending.get("paymentReceivedFor") == payment_hash:
                settle_pending(now=now)
                return {"result": "already-paid", "paymentHash": payment_hash}
            try:
                api_state = _payment_state(payment_hash)
            except Exception:
                api_state = "unknown"
            if api_state in ("processing", "paid"):
                _mark_payment_received("pendingRenewal", pending, payment_hash)
                settle_pending(now=now)
                return {"result": "already-paid", "paymentHash": payment_hash}
            nwc_was_attempted = bool(pending.get("paidViaNwc") or pending.get("nwcAttempted"))
            if nwc_was_attempted and _nwc_lookup_already_paid(
                parsed_uri, payment_hash, route_via_tor=route_via_tor
            ):
                with meta_lock():
                    fresh_meta = read_meta()
                    cur_p = fresh_meta.get("pendingRenewal")
                    if isinstance(cur_p, dict) and cur_p.get("paymentHash") == payment_hash:
                        cur_p["paidViaNwc"] = True
                        cur_p["paymentReceivedFor"] = payment_hash
                        atomic_write_json(META_FILE_PATH, fresh_meta)
                settle_pending(now=now)
                return {"result": "already-paid", "paymentHash": payment_hash}

            inv = pending.get("invoice")
            inv_exp_dt = _invoice_expiry(pending)
            if api_state == "unknown" and nwc_was_attempted:
                return {
                    "result": "deferred-unknown-status",
                    "paymentHash": payment_hash,
                    "message": "TunnelSats payment status is temporarily unavailable; keeping existing invoice.",
                }
            if (
                api_state in ("unpaid", "unknown")
                and isinstance(inv, str)
                and inv_exp_dt is not None
                and now < inv_exp_dt
            ):
                reusable_pending = dict(pending)

        if reusable_pending is None and isinstance(pending, dict) and isinstance(pending.get("paymentHash"), str) and pending.get("paymentHash"):
            stale_hash = pending.get("paymentHash")
            stale_node = pending.get("targetNode")

        if reusable_pending is None:
            raw_server = meta.get("serverDomain")
            if not isinstance(raw_server, str) or not raw_server.strip() or raw_server.strip() in ("Unknown", "None"):
                cfg_host = None
                try:
                    with open(CONFIG_PATH, "r") as f:
                        cfg_host = extract_server_host(f.read())
                except OSError:
                    cfg_host = None
                raw_server = (
                    cfg_host
                    if isinstance(cfg_host, str) and cfg_host.strip() and cfg_host.strip() not in ("Unknown", "None")
                    else "eu-de"
                )
            server_id = raw_server.strip()
            try:
                _status, renew_data = _api_call(
                    "POST",
                    "/subscription/renew",
                    {"serverId": server_id, "wgPublicKey": wg_pubkey, "duration": months},
                )
            except Exception as e:
                err = NwcError(f"Could not create TunnelSats renewal invoice: {e}", code="API_ERROR", permanent=False)
                _record_nwc_failure(wg_pubkey, None, err, now)
                return {"result": "failed", "message": str(err)}

            payment_hash = str(renew_data.get("paymentHash") or "").strip().lower()
            invoice = str(renew_data.get("invoice") or "").strip()
            try:
                verified_sats = _verify_bolt11_invoice(invoice, payment_hash)
            except NwcVerificationError as e:
                _record_nwc_failure(wg_pubkey, None, e, now, force_fallback=True)
                return {"result": "verification-failed", "message": str(e)}

            reusable_pending = {
                "renewalId": str(renew_data.get("renewalId") or payment_hash),
                "paymentHash": payment_hash,
                "invoice": invoice,
                "amountSats": verified_sats,
                "duration": months,
                "publicKey": wg_pubkey,
                "targetNode": get_target_node(),
                "createdAt": _iso(now),
                "expiresAt": renew_data.get("expiresAt") or _iso(now + INVOICE_DEFAULT_TTL),
                "oldExpiry": meta.get("expiresAt") or "",
                "newExpiry": renew_data.get("newExpiry") or "",
                "paidViaNwc": False,
                "nwcAttempted": False,
                "raisePayTask": False,
            }
            # Persist pendingRenewal under meta_lock BEFORE attempting payment,
            # checking that no concurrent manual Renew wrote a pendingRenewal first.
            used_concurrent = False
            with meta_lock():
                fresh_meta = read_meta()
                concurrent_pending = fresh_meta.get("pendingRenewal")
                c_hash = concurrent_pending.get("paymentHash") if isinstance(concurrent_pending, dict) else None
                c_recv = concurrent_pending.get("paymentReceivedFor") if isinstance(concurrent_pending, dict) else None
                c_exp = _invoice_expiry(concurrent_pending) if isinstance(concurrent_pending, dict) else None
                
                if (
                    isinstance(concurrent_pending, dict)
                    and concurrent_pending.get("publicKey") == wg_pubkey
                    and isinstance(c_hash, str)
                    and c_hash
                    and c_hash != stale_hash
                    and c_recv in (None, c_hash)
                    and isinstance(concurrent_pending.get("invoice"), str)
                    and c_exp is not None
                    and now < c_exp
                ):
                    reusable_pending = dict(concurrent_pending)
                    used_concurrent = True
                else:
                    fresh_meta["pendingRenewal"] = reusable_pending
                    hash_to_clear = c_hash if c_hash else stale_hash
                    node_to_clear = concurrent_pending.get("targetNode") if (isinstance(concurrent_pending, dict) and c_hash) else stale_node
                    if hash_to_clear and node_to_clear in TARGET_NODES and hash_to_clear != reusable_pending.get("paymentHash"):
                        tasks = [t for t in fresh_meta.get("payTasksToClear") or [] if isinstance(t, str)]
                        replay_id = pay_task_replay_id("renewal", node_to_clear, hash_to_clear)
                        if replay_id not in tasks:
                            tasks.append(replay_id)
                        fresh_meta["payTasksToClear"] = tasks
                    atomic_write_json(META_FILE_PATH, fresh_meta)
            if used_concurrent:
                payment_hash = reusable_pending["paymentHash"]
                invoice = reusable_pending["invoice"]
                try:
                    verified_sats = _verify_bolt11_invoice(invoice, payment_hash)
                except NwcVerificationError as e:
                    _record_nwc_failure(wg_pubkey, None, e, now, force_fallback=True)
                    return {"result": "verification-failed", "message": str(e)}
        else:
            payment_hash = reusable_pending["paymentHash"]
            invoice = reusable_pending["invoice"]
            try:
                verified_sats = _verify_bolt11_invoice(invoice, payment_hash)
            except NwcVerificationError as e:
                _record_nwc_failure(wg_pubkey, None, e, now, force_fallback=True)
                return {"result": "verification-failed", "message": str(e)}

        # Pre-flight budget/balance check before calling pay_invoice
        budget_ok, budget_code, budget_msg = _nwc_preflight_budget_check(
            parsed_uri,
            verified_sats,
            route_via_tor=route_via_tor,
        )
        if not budget_ok:
            err = NwcError(budget_msg, code=budget_code or "QUOTA_EXCEEDED", permanent=True, budget=True)
            _record_nwc_failure(wg_pubkey, payment_hash, err, now, force_fallback=True, budget_warning=True)
            return {"result": "budget-insufficient", "paymentHash": payment_hash, "message": budget_msg}

        # Re-verify under meta_lock that the wallet was not disconnected or
        # replaced during invoice creation / budget preflight, and mark
        # nwcAttempted = True before sending pay_invoice.
        with meta_lock():
            pre_pay_meta = read_meta()
            latest_wallet_doc = _read_json_object(NWC_WALLET_FILE_PATH)
            if (
                pre_pay_meta.get("nwcConnected") is not True
                or not isinstance(latest_wallet_doc, dict)
                or latest_wallet_doc.get("uri") != wallet_doc["uri"]
            ):
                return {
                    "result": "disabled",
                    "message": "NWC wallet was disconnected or updated before payment.",
                }
            cur_pending = pre_pay_meta.get("pendingRenewal")
            if isinstance(cur_pending, dict) and cur_pending.get("paymentHash") == payment_hash:
                cur_pending["nwcAttempted"] = True
                atomic_write_json(META_FILE_PATH, pre_pay_meta)

        try:
            nwc_execute_command(
                parsed_uri,
                "pay_invoice",
                {"invoice": invoice},
                route_via_tor=route_via_tor,
            )
        except NwcError as e:
            tripped = _record_nwc_failure(
                wg_pubkey,
                payment_hash,
                e,
                now,
                force_fallback=e.permanent,
                budget_warning=e.budget,
            )
            return {
                "result": "fallback-raised" if tripped else "retry-scheduled",
                "paymentHash": payment_hash,
                "message": str(e),
            }

        # Payment succeeded! Mark received and record NWC payment metadata.
        # Note: lastPaidNewExpiry stays None until _settle_renewal confirms the
        # extended expiry via lazy_sync and calls _clear_pending, so the
        # nwc-renewed notification is never emitted before confirmation.
        with meta_lock():
            fresh_meta = read_meta()
            current_pending = fresh_meta.get("pendingRenewal")
            if isinstance(current_pending, dict) and current_pending.get("paymentHash") == payment_hash:
                current_pending["paymentReceivedFor"] = payment_hash
                current_pending["paidViaNwc"] = True
                current_pending["raisePayTask"] = False
            fresh_meta["lastDuration"] = months
            fresh_meta["lastAmountSats"] = verified_sats
            post_pay_wallet = _read_json_object(NWC_WALLET_FILE_PATH)
            if (
                fresh_meta.get("nwcConnected") is True
                and isinstance(post_pay_wallet, dict)
                and post_pay_wallet.get("uri") == wallet_doc["uri"]
            ):
                nwc_state = dict(fresh_meta.get("nwcAutoRenewState")) if isinstance(fresh_meta.get("nwcAutoRenewState"), dict) else {}
                nwc_state.update({
                    "periodExpiry": fresh_meta.get("expiresAt"),
                    "attempts": 0,
                    "lastAttemptAt": _iso(now),
                    "nextAttemptAt": None,
                    "lastError": None,
                    "lastErrorCode": None,
                    "budgetWarning": False,
                    "fallbackTaskRaised": False,
                    "restoreReconnectNeeded": False,
                    "lastPaidHash": payment_hash,
                    "lastPaidAt": _iso(now),
                    "lastPaidDuration": months,
                    "lastPaidAmountSats": verified_sats,
                    "lastPaidNewExpiry": None,
                })
                fresh_meta["nwcAutoRenewState"] = nwc_state
            atomic_write_json(META_FILE_PATH, fresh_meta)

        settle_pending(now=now)
        return {"result": "paid", "paymentHash": payment_hash, "amountSats": verified_sats}


def get_dashboard():
    """The dashboard read model. See the section comment above: an explicit
    allow-list, never a secret."""
    status = get_status()
    configured = bool(status.get("configured"))
    public_key = status.get("pubkey") if configured else None
    if public_key in ("Unknown", "None", "Not available") or not isinstance(public_key, str):
        public_key = None
    meta = read_meta()
    server = status.get("server")
    vpn_ip = status.get("vpn_ip")
    days = status.get("days_remaining")
    now = datetime.now(timezone.utc)
    return {
        "version": _dashboard_short_text(status.get("version")),
        "enabled": bool(status.get("enabled")),
        "configured": configured,
        "status": _dashboard_short_text(status.get("status")),
        "targetNode": get_target_node(),
        "plans": PLAN_PRICES_USD,
        "subscription": {
            "active": bool(status.get("subscription_active")),
            "linked": bool(status.get("subscription_linked")),
            "expiresAt": _dashboard_time(status.get("expires_at")),
            "daysRemaining": days if type(days) is int else None,
            "keyUnknown": bool(status.get("key_unknown")),
            "lastSync": _dashboard_time(status.get("last_sync")),
            "syncError": _dashboard_error_text(status.get("sync_error")),
        },
        "connection": {
            "server": _dashboard_text(server, 253) if server != "Unknown" else None,
            "vpnPort": valid_vpn_port(status.get("vpn_port")) if configured else None,
            "vpnIp": _dashboard_short_text(vpn_ip) if vpn_ip != "None" else None,
            "publicKey": public_key,
            "allowIpv6": bool(status.get("allow_ipv6")),
        },
        "bandwidth": _bandwidth_summary(meta, public_key, now),
        "pending": {
            "order": _pending_summary(meta, "pendingOrder", public_key, now=now),
            "renewal": _pending_summary(meta, "pendingRenewal", public_key, now=now),
            "reset": _pending_summary(meta, "pendingReset", public_key, now=now),
        },
        "intents": _intents_summary(now=now),
        "handoff": _handoff_summary(),
        "notices": _notices_summary(public_key),
        "nwc": _nwc_summary(meta),
    }

def main():
    if len(sys.argv) < 2:
        print("Usage: bridge.py <command> [args]")
        sys.exit(1)

    command = sys.argv[1]

    if command == "start":
        signal.signal(signal.SIGTERM, shutdown_handler)
        signal.signal(signal.SIGINT, shutdown_handler)
        try:
            import threading
            sync_thread = threading.Thread(target=subscription_sync_loop, daemon=True)
            sync_thread.start()

            web_thread = threading.Thread(target=web_server_thread, daemon=True)
            web_thread.start()

            print("TunnelSats companion service started.")

            while True:
                time.sleep(1)
        except Exception as e:
            stderr = getattr(e, 'stderr', str(e))
            print(f"Failed to start companion service: {stderr}", file=sys.stderr)
            sys.exit(1)

    elif command == "stop":
        print("TunnelSats companion service stopped.")
        sys.exit(0)

    elif command == "status":
        print(json.dumps(get_status(), indent=2))

    elif command == "settle":
        # Runs regardless of `enabled`: a first Buy completes on a package
        # that has no configuration (and is therefore disabled) yet.
        print(json.dumps(settle_pending()))

    elif command == "meta-lock":
        # Held by the TypeScript runtime around its metadata/config writes
        # (startos/metaLock.ts); released when it closes stdin.
        sys.exit(hold_meta_lock(sys.stdin.fileno(), sys.stdout))

    elif command == "settle-ack":
        ack_pay_tasks(sys.argv[2:])
        print(json.dumps({"acknowledged": sys.argv[2:]}))

    elif command == "health":
        target = sys.argv[2] if len(sys.argv) > 2 else "subscription"

        if not is_enabled():
            print(json.dumps({"result": "disabled", "message": "TunnelSats is disabled."}))
            sys.exit(0)

        if not os.path.exists(CONFIG_PATH):
            print(json.dumps({"result": "ok", "message": "Unconfigured: Add WireGuard configuration in settings"}))
            sys.exit(0)

        pubkey = get_wg_pubkey()
        sub_info = get_subscription_info(pubkey)
        confirmed = bool(sub_info.get("linked"))

        if not confirmed and not sub_info.get("syncError"):
            if pubkey and pubkey not in ("Unknown", "Not available"):
                try:
                    lazy_sync(pubkey)
                    sub_info = get_subscription_info(pubkey)
                    confirmed = bool(sub_info.get("linked"))
                except Exception as e:
                    print(json.dumps({"result": "failure", "message": f"Subscription synchronization failed: {e}"}))
                    sys.exit(1)

        if pubkey and pubkey not in ("Unknown", "Not available"):
            try:
                nwc_res = maybe_nwc_auto_renew(pubkey)
                if nwc_res.get("result") in ("paid", "already-paid"):
                    sub_info = get_subscription_info(pubkey)
                    confirmed = bool(sub_info.get("linked"))
            except Exception as nwc_err:
                print(f"NWC auto-renewal check failed: {nwc_err}", file=sys.stderr)

        if sub_info.get("keyUnknown"):
            # A definitive answer, not a failed sync: the key has no subscription.
            print(json.dumps({"result": "failure", "message": UNKNOWN_KEY_MESSAGE}))
            sys.exit(1)
        elif sub_info.get("syncError"):
            print(json.dumps({"result": "failure", "message": f"Subscription synchronization failed: {sub_info['syncError']}"}))
            sys.exit(1)
        elif sub_info.get("isExpired"):
            print(json.dumps({"result": "failure", "message": f"Subscription expired on {sub_info['expiresAt']}"}))
            sys.exit(1)
        elif confirmed:
            print(json.dumps({"result": "ok", "message": sub_info["formatted"]}))
            sys.exit(0)
        else:
            print(json.dumps({"result": "loading", "message": "Synchronizing subscription status with TunnelSats..."}))
            sys.exit(0)



    else:
        print(f"Unknown command: {command}")
        sys.exit(1)

if __name__ == "__main__":
    main()
