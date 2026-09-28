#!/usr/bin/env python3
import sys
import re
import os
import json
import subprocess
import signal
import fcntl
import time
import socket
import ipaddress
import math
import urllib.request
import urllib.error
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone


DEFAULT_VPN_PORT = 9735
DATA_DIR = os.getenv("DATA_DIR", "/data")
CONFIG_PATH = os.path.join(DATA_DIR, "tunnelsatsv3.conf")
APP_CONFIG_PATH = os.path.join(DATA_DIR, "config.json")
META_FILE_PATH = os.path.join(DATA_DIR, "tunnelsats-meta.json")
TUNNELSATS_API_URL = "https://tunnelsats.com/api/public/v1"
# Fields that only hold for the key they were confirmed for (see lazy_sync).
CONFIRMED_META_FIELDS = ("expiresAt", "expirySource", "lastSync", "syncSuccess", "bandwidth_used_gb")
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
    metadata file. The dashboard's sync thread, the forced sync, the health
    check (a separate process) and save_configuration all rewrite it; without
    the lock one writer can replace another's newer result with metadata it
    loaded before a slow API request. The purchase actions (TypeScript
    FileHelper.merge of pendingOrder/pendingRenewal) cannot take this lock;
    every writer here therefore merges into a fresh read taken right before
    its write, which narrows their window to the read-to-rename span."""
    fd = os.open(META_FILE_PATH + ".lock", os.O_RDWR | os.O_CREAT, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        yield
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

def generate_wg_keypair():
    try:
        proc_priv = subprocess.run(["wg", "genkey"], capture_output=True, check=True)
        priv = proc_priv.stdout.decode().strip()
        proc_pub = subprocess.run(["wg", "pubkey"], input=priv.encode(), capture_output=True, check=True)
        pub = proc_pub.stdout.decode().strip()
        if priv and pub:
            return priv, pub
    except Exception:
        pass

    try:
        from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey
        from cryptography.hazmat.primitives import serialization
        import base64
        key = X25519PrivateKey.generate()
        raw_priv = key.private_bytes(
            encoding=serialization.Encoding.Raw,
            format=serialization.PrivateFormat.Raw,
            encryption_algorithm=serialization.NoEncryption()
        )
        raw_pub = key.public_key().public_bytes(
            encoding=serialization.Encoding.Raw,
            format=serialization.PublicFormat.Raw
        )
        return base64.b64encode(raw_priv).decode(), base64.b64encode(raw_pub).decode()
    except Exception as e:
        raise RuntimeError(f"Unable to generate WireGuard keypair: {e}")

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
    configuration: the TypeScript actions write it without meta_lock, first
    config.json, then the conf file, so a save is in flight and wins),
    "no-config" or "no-marker". Raises OSError when a write fails.

    config.json is written first: after an interruption it holds the
    rewritten configuration while the conf file does not, and the next call
    completes the rewrite. The reverse order would strand config.json.

    config.json is only replaced while its stamp still matches the one taken
    before it was read (_write_json_if_unchanged). Residual window: an
    import whose in-place write lands between that last stat and the rename
    is overwritten with the rewritten old configuration, and the operator
    has to save again. Closing it needs the TypeScript actions to share
    meta_lock, which they cannot take."""
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
        # Missing, or caught mid-write by an in-place TypeScript write.
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

        with meta_lock():
            if _superseded(wg_pubkey):
                print("Subscription sync result dropped: the configured key changed", file=sys.stderr)
                return "superseded"
            # Merge into a fresh read: the request can take a minute, and
            # other writers may have updated the file meanwhile.
            meta = read_meta()
            _bind_meta_to_key(meta, wg_pubkey)
            meta.update(fields)
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


def _clear_pending(meta, key, payment_hash):
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
    return True


def _finish_pending(key, payment_hash):
    with meta_lock():
        meta = read_meta()
        if _clear_pending(meta, key, payment_hash):
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


def _settle_order(pending, now):
    payment_hash = pending["paymentHash"]
    state = _payment_state(payment_hash)
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
            _finish_pending("pendingRenewal", payment_hash)
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
    if outcome["result"] == "waiting" and ("lastError" in pending or "nextAttemptAt" in pending):
        _update_pending(key, payment_hash, {"lastError": None, "nextAttemptAt": None})
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

class DashboardHTTPRequestHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass

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
        path_only = self.path.partition('?')[0].partition('#')[0]
        if path_only == "/api/status":
            if not self.is_trusted_request():
                return

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
                "bandwidth_limit_gb": 100,
                "csrf_token": get_csrf_token(),
            }
            self.wfile.write(json.dumps(response).encode("utf-8"))
            return

        if path_only == "/api/csrf":
            if not self.is_trusted_request():
                return
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"csrf_token": get_csrf_token()}).encode("utf-8"))
            return

        web_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), "web"))
        target_path = path_only.lstrip("/")
        if not target_path or target_path == "":
            target_path = "index.html"

        safe_path = os.path.abspath(os.path.join(web_dir, target_path))
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

    def do_POST(self):
        path_only = self.path.partition('?')[0].partition('#')[0]
        if not self.is_trusted_request():
            return

        if path_only == "/api/keys/generate":
            try:
                priv, pub = generate_wg_keypair()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"private_key": priv, "public_key": pub}).encode("utf-8"))
            except Exception as e:
                self.send_error(500, f"Key generation failed: {e}")
            return

        if path_only == "/api/config/save":
            try:
                # Protect active configuration from unauthenticated replacement
                if os.path.exists(CONFIG_PATH):
                    # Fail closed: from the unauthenticated web UI, only a
                    # subscription positively known to be expired may be replaced.
                    sub_info = get_subscription_info(get_wg_pubkey())
                    if not sub_info.get("isExpired"):
                        self.send_response(403)
                        self.send_header("Content-Type", "application/json")
                        self.end_headers()
                        self.wfile.write(json.dumps({
                            "error": "Active configuration already present. Replacing an active configuration requires operator authentication in StartOS (Services → TunnelSats → Configure)."
                        }).encode("utf-8"))
                        return

                content_length = int(self.headers.get('Content-Length', 0))
                body = self.rfile.read(content_length).decode('utf-8')
                data = json.loads(body)
                conf = data.get("config", "").strip()
                target_node = data.get("target_node", "lnd")
                if not conf:
                    self.send_response(400)
                    self.send_header("Content-Type", "application/json")
                    self.end_headers()
                    self.wfile.write(json.dumps({"error": "No configuration provided"}).encode("utf-8"))
                    return

                save_configuration(conf, target_node)

                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"success": True, "message": "Configuration saved. Accept the routing prompt on your Lightning node."}).encode("utf-8"))
            except Exception as e:
                self.send_response(400)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"error": str(e)}).encode("utf-8"))
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
            server_match = re.search(r"^#\s*Server:\s*([^\s#]+)", content, re.IGNORECASE | re.MULTILINE)
            if server_match:
                server_domain = server_match.group(1).strip()
            else:
                endpoint_match = re.search(r"^\s*(?!#|;)\s*Endpoint\s*=\s*([^\s#:]+)", content, re.IGNORECASE | re.MULTILINE)
                if endpoint_match:
                    server_domain = endpoint_match.group(1).strip()
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
        "bandwidth_limit_gb": 100,
        "version": get_package_version(),
        "allow_ipv6": is_allow_ipv6(),
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
