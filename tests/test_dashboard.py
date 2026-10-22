"""Dashboard read model (GET /api/dashboard) and intent bridge (POST /api/intents).

The dashboard is reachable from the LAN without operator authentication, so
the read model is an explicit allow-list: it must never carry a private key,
a payment hash, the WireGuard configuration or any other secret. Only an
unpaid, non-expired BOLT11 invoice is exposed so the operator can scan or
copy the exact invoice raised on the Lightning node. These tests run
get_dashboard and the real HTTP handler against real state files in a
temporary directory.
"""
import base64
import json
import os
import re
import socket
import sys
import tempfile
import threading
import unittest
import http.client
from datetime import datetime, timedelta, timezone
from http.server import ThreadingHTTPServer
from unittest.mock import patch

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))
import bridge

# Any key that looks like it could hold secret material fails the test.
FORBIDDEN_KEY_RE = re.compile(r"private|secret|preshared|psk|password|macaroon|token|paymenthash",
                              re.IGNORECASE)

ORDER_HASH = "a" * 64
RENEW_HASH = "b" * 64
RESET_HASH = "c" * 64
PSK = "cHNrLXBzay1wc2stcHNrLXBzay1wc2stcHNrLXBzay0="
SERVER_PUB = "c2VydmVyLXB1YmtleS1zZXJ2ZXItcHVia2V5LXNlcnY="
ORDER_INVOICE = "lnbc250u1pjorderinvoiceorderinvoiceorderinvoice"
RESET_INVOICE = "lnbc10u1pjresetinvoiceresetinvoiceresetinvoice"


def new_keypair():
    """A fresh WireGuard keypair; the public key comes from the production
    derivation (wg pubkey)."""
    private_key = base64.b64encode(os.urandom(32)).decode()
    public_key = bridge.derive_wg_pubkey(private_key)
    assert public_key, "wg pubkey is required for these tests"
    return private_key, public_key


def forbidden_keys(value, path="$"):
    """Every key in value (recursively) that matches FORBIDDEN_KEY_RE."""
    found = []
    if isinstance(value, dict):
        for key, child in value.items():
            if FORBIDDEN_KEY_RE.search(str(key)):
                found.append(f"{path}.{key}")
            found += forbidden_keys(child, f"{path}.{key}")
    elif isinstance(value, list):
        for i, child in enumerate(value):
            found += forbidden_keys(child, f"{path}[{i}]")
    return found


class DashboardStateTestBase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        d = self._tmp.name
        self._names = (
            "CONFIG_PATH",
            "APP_CONFIG_PATH",
            "META_FILE_PATH",
            "HANDOFF_FILE_PATH",
            "NOTICES_FILE_PATH",
            "INTENTS_FILE_PATH",
            "INTENT_RESULTS_FILE_PATH",
        )
        self._orig = {name: getattr(bridge, name) for name in self._names}
        bridge.CONFIG_PATH = os.path.join(d, "tunnelsatsv3.conf")
        bridge.APP_CONFIG_PATH = os.path.join(d, "config.json")
        bridge.META_FILE_PATH = os.path.join(d, "tunnelsats-meta.json")
        bridge.HANDOFF_FILE_PATH = os.path.join(d, "vpn-handoff.json")
        bridge.NOTICES_FILE_PATH = os.path.join(d, "subscription-notices.json")
        bridge.INTENTS_FILE_PATH = os.path.join(d, "dashboard-intents.json")
        bridge.INTENT_RESULTS_FILE_PATH = os.path.join(d, "dashboard-intent-results.json")
        bridge._pubkey_cache = None
        bridge._enabled_cache = None
        bridge._enabled_cache_mtime = 0
        self.now = datetime.now(timezone.utc).replace(microsecond=0)

    def tearDown(self):
        for name, value in self._orig.items():
            setattr(bridge, name, value)
        bridge._pubkey_cache = None
        bridge._enabled_cache = None
        bridge._enabled_cache_mtime = 0
        self._tmp.cleanup()

    def write_json(self, path, data):
        with open(path, "w") as f:
            json.dump(data, f)

    def iso(self, dt):
        return dt.isoformat().replace("+00:00", "Z")

    def configure(self, target="eclair"):
        """Stores a configuration for a fresh key; returns (private, public, conf)."""
        priv, pub = new_keypair()
        conf = (
            "[Interface]\n"
            f"PrivateKey = {priv}\n"
            "Address = 10.9.0.7/32\n"
            "# Server: de2.tunnelsats.com\n"
            "# Port Forwarding: 24556\n"
            "\n"
            "[Peer]\n"
            f"PublicKey = {SERVER_PUB}\n"
            f"PresharedKey = {PSK}\n"
            "Endpoint = de2.tunnelsats.com:51820\n"
            "AllowedIPs = 0.0.0.0/0, ::/0\n"
        )
        with open(bridge.CONFIG_PATH, "w") as f:
            f.write(conf)
        self.write_json(bridge.APP_CONFIG_PATH, {
            "enabled": True, "target-node": target, "tunnelsats-conf": conf, "allow-ipv6": False,
        })
        return priv, pub, conf


class TestDashboardReadModel(DashboardStateTestBase):
    def full_state(self):
        priv, pub, conf = self.configure("eclair")
        order_priv, order_pub = new_keypair()
        expiry = self.now + timedelta(days=20)
        self.write_json(bridge.META_FILE_PATH, {
            "publicKey": pub,
            "expiresAt": self.iso(expiry),
            "expirySource": "api",
            "lastSync": self.iso(self.now),
            "syncSuccess": True,
            "syncError": None,
            "serverDomain": "de2.tunnelsats.com",
            "vpnPort": 24556,
            "bandwidth_used_gb": 42.5,
            "provisionedKey": pub,
            "pendingOrder": {
                "paymentHash": ORDER_HASH, "orderId": "order-123", "privateKey": order_priv,
                "publicKey": order_pub, "targetNode": "cln", "serverId": "eu-de",
                "duration": 3, "createdAt": self.iso(self.now), "invoice": ORDER_INVOICE,
            },
            "pendingRenewal": {
                "paymentHash": RENEW_HASH, "renewalId": "renew-456",
                "oldExpiry": self.iso(expiry), "newExpiry": self.iso(expiry + timedelta(days=30)),
                "createdAt": self.iso(self.now), "publicKey": pub, "targetNode": "eclair",
                "lastError": "HTTP 503 from the TunnelSats API: unavailable",
                "nextAttemptAt": self.iso(self.now + timedelta(minutes=5)),
            },
            "pendingReset": {
                "paymentHash": RESET_HASH, "resetId": "reset-789", "invoice": RESET_INVOICE,
                "expiresAt": self.iso(self.now + timedelta(hours=1)), "createdAt": self.iso(self.now),
                "publicKey": pub, "serverId": "eu-de", "targetNode": "eclair", "amountSats": 1500,
                "lastError": (
                    f"The payment was received, but the bandwidth reset failed. "
                    f"Contact TunnelSats support with payment hash {RESET_HASH}."
                ),
            },
            "payTasksToClear": ["tunnelsats-order:lnd:" + ORDER_HASH[:16]],
        })
        self.write_json(bridge.HANDOFF_FILE_PATH, {
            "activeTarget": "eclair", "pendingOff": ["lnd"], "handedOutKeys": [pub, order_pub],
            "unraised": [], "retryOwnTasks": False,
        })
        self.write_json(bridge.NOTICES_FILE_PATH, {
            "publicKey": pub, "expiresAt": self.iso(expiry), "sent": ["7d", "bogus"],
            "sentFor": self.iso(expiry),
        })
        return {"priv": priv, "pub": pub, "conf": conf, "order_priv": order_priv,
                "order_pub": order_pub, "expiry": expiry}

    def test_full_state_is_summarized(self):
        s = self.full_state()
        model = bridge.get_dashboard()

        self.assertTrue(model["enabled"])
        self.assertTrue(model["configured"])
        self.assertEqual(model["status"], "running")
        self.assertEqual(model["targetNode"], "eclair")
        self.assertEqual(model["subscription"], {
            "active": True, "linked": True, "expiresAt": self.iso(s["expiry"]),
            "daysRemaining": model["subscription"]["daysRemaining"], "keyUnknown": False,
            "lastSync": self.iso(self.now), "syncError": None,
        })
        self.assertIn(model["subscription"]["daysRemaining"], (19, 20))
        self.assertEqual(model["connection"], {
            "server": "de2.tunnelsats.com", "vpnPort": 24556, "vpnIp": "10.9.0.7",
            "publicKey": s["pub"], "allowIpv6": False,
        })
        self.assertEqual(model["plans"], bridge.PLAN_PRICES_USD)
        self.assertEqual(model["bandwidth"], {
            "usedGb": 42.5, "limitGb": 100, "resetsThisMonth": None, "maxResetsPerMonth": None,
        })
        self.assertEqual(model["pending"]["order"], {
            "targetNode": "cln", "serverId": "eu-de", "duration": "3m",
            "createdAt": self.iso(self.now),
            "expiresAt": self.iso(self.now + timedelta(hours=1)),
            "amountSats": 25000,
            "lastError": None, "nextAttemptAt": None, "paymentReceived": False,
            "invoice": ORDER_INVOICE,
        })
        self.assertEqual(model["pending"]["renewal"]["targetNode"], "eclair")
        self.assertEqual(model["pending"]["renewal"]["lastError"],
                         "HTTP 503 from the TunnelSats API: unavailable")
        self.assertFalse(model["pending"]["renewal"]["paymentReceived"])
        self.assertIsNone(model["pending"]["renewal"]["invoice"])
        self.assertEqual(model["pending"]["reset"]["amountSats"], 1500)
        self.assertTrue(model["pending"]["reset"]["paymentReceived"])
        self.assertIsNone(model["pending"]["reset"]["invoice"])
        self.assertEqual(
            model["pending"]["reset"]["lastError"],
            "The payment was received, but the bandwidth reset failed. "
            "Contact TunnelSats support with the payment hash from the Reset Bandwidth action.",
        )
        self.assertEqual(model["intents"], {"buy": None, "renew": None, "reset": None})
        self.assertEqual(model["handoff"], {"activeTarget": "eclair", "pendingOff": ["lnd"], "unraised": []})
        self.assertEqual(model["notices"], {"sent": ["7d"], "unknownKey": False})

    def test_read_model_never_carries_secrets(self):
        s = self.full_state()
        meta = bridge.read_meta()
        meta["recoveredOrderConfigs"] = {ORDER_HASH: s["conf"]}
        self.write_json(bridge.META_FILE_PATH, meta)
        model = bridge.get_dashboard()

        self.assertEqual(forbidden_keys(model), [])
        body = json.dumps(model)
        # ORDER_INVOICE is unpaid and non-expired so it is exposed on pending.order.invoice;
        # RESET_INVOICE has paymentReceived=True so it is omitted.
        self.assertEqual(model["pending"]["order"]["invoice"], ORDER_INVOICE)
        for secret in (s["priv"], s["order_priv"], PSK, s["conf"], RESET_INVOICE,
                       ORDER_HASH, RENEW_HASH, RESET_HASH, "order-123", "renew-456", "reset-789"):
            self.assertNotIn(secret, body)
        # Public keys the operator does not need (an unpaid order's, the
        # handed-out list) stay out as well.
        self.assertNotIn(s["order_pub"], body)
        self.assertNotIn("payTasksToClear", body)
        self.assertNotIn("handedOutKeys", body)
        self.assertNotIn("recoveredOrderConfigs", body)

    def test_payable_invoice_omitted_when_paid_expired_or_malformed(self):
        order_priv, order_pub = new_keypair()
        # 1. Paid invoice is omitted
        self.write_json(bridge.META_FILE_PATH, {
            "pendingOrder": {
                "paymentHash": ORDER_HASH, "orderId": "o", "privateKey": order_priv,
                "publicKey": order_pub, "targetNode": "lnd", "serverId": "eu-de",
                "createdAt": self.iso(self.now), "invoice": ORDER_INVOICE,
                "paymentReceivedFor": ORDER_HASH,
            },
        })
        model = bridge.get_dashboard()
        self.assertTrue(model["pending"]["order"]["paymentReceived"])
        self.assertIsNone(model["pending"]["order"]["invoice"])
        self.assertNotIn(ORDER_INVOICE, json.dumps(model))

        # 2. Expired invoice is omitted
        self.write_json(bridge.META_FILE_PATH, {
            "pendingOrder": {
                "paymentHash": ORDER_HASH, "orderId": "o", "privateKey": order_priv,
                "publicKey": order_pub, "targetNode": "lnd", "serverId": "eu-de",
                "createdAt": self.iso(self.now - timedelta(hours=2)),
                "expiresAt": self.iso(self.now - timedelta(minutes=1)),
                "invoice": ORDER_INVOICE,
            },
        })
        model = bridge.get_dashboard()
        self.assertFalse(model["pending"]["order"]["paymentReceived"])
        self.assertIsNone(model["pending"]["order"]["invoice"])
        self.assertNotIn(ORDER_INVOICE, json.dumps(model))

        # 3. Malformed / non-BOLT11 invoice is rejected
        self.write_json(bridge.META_FILE_PATH, {
            "pendingOrder": {
                "paymentHash": ORDER_HASH, "orderId": "o", "privateKey": order_priv,
                "publicKey": order_pub, "targetNode": "lnd", "serverId": "eu-de",
                "createdAt": self.iso(self.now), "invoice": "javascript:alert(1)",
            },
        })
        model = bridge.get_dashboard()
        self.assertIsNone(model["pending"]["order"]["invoice"])

    def test_imported_ipv6_endpoint_extracts_full_address(self):
        priv, _ = new_keypair()
        _, server_pub = new_keypair()
        ipv6_conf = (
            "[Interface]\n"
            f"PrivateKey = {priv}\n"
            "Address = 10.9.0.7/32\n\n"
            "[Peer]\n"
            f"PublicKey = {server_pub}\n"
            f"PresharedKey = {PSK}\n"
            "Endpoint = [2001:db8::42]:51820\n"
            "AllowedIPs = 0.0.0.0/0, ::/0\n"
            "# Port Forwarding: 24556\n"
        )
        bridge.save_configuration(ipv6_conf, "lnd")
        model = bridge.get_dashboard()
        self.assertEqual(model["connection"]["server"], "2001:db8::42")
        self.assertEqual(model["connection"]["vpnPort"], 24556)

    def test_forbidden_key_check_catches_a_leak(self):
        # Guards the guard: a nested secret-like key is reported.
        leaked = {"pending": {"order": {"privateKey": "x"}}, "list": [{"paymentHash": "y"}]}
        self.assertEqual(forbidden_keys(leaked), ["$.pending.order.privateKey", "$.list[0].paymentHash"])

    def test_unconfigured_with_pending_order(self):
        order_priv, order_pub = new_keypair()
        self.write_json(bridge.META_FILE_PATH, {
            "pendingOrder": {
                "paymentHash": ORDER_HASH, "orderId": "o", "privateKey": order_priv,
                "publicKey": order_pub, "targetNode": "lnd", "serverId": "us-east",
                "createdAt": self.iso(self.now),
            },
        })
        model = bridge.get_dashboard()
        self.assertFalse(model["configured"])
        self.assertFalse(model["enabled"])
        self.assertEqual(model["status"], "disabled")
        self.assertEqual(model["targetNode"], "lnd")
        self.assertIsNone(model["connection"]["publicKey"])
        self.assertIsNone(model["connection"]["vpnPort"])
        self.assertIsNone(model["connection"]["vpnIp"])
        self.assertIsNone(model["bandwidth"]["usedGb"])
        self.assertEqual(model["pending"]["order"]["targetNode"], "lnd")
        self.assertFalse(model["pending"]["order"]["paymentReceived"])
        self.assertIsNone(model["pending"]["renewal"])
        self.assertIsNone(model["handoff"])
        self.assertIsNone(model["notices"])
        self.assertNotIn(order_priv, json.dumps(model))

        # When settlement marks the invoice as received, paymentReceived is True,
        # but if a new Buy deep-merges a different paymentHash without clearing
        # paymentReceivedFor, the new invoice must not appear paid.
        self.write_json(bridge.META_FILE_PATH, {
            "pendingOrder": {
                "paymentHash": ORDER_HASH, "orderId": "o", "privateKey": order_priv,
                "publicKey": order_pub, "targetNode": "lnd", "serverId": "us-east",
                "createdAt": self.iso(self.now), "paymentReceivedFor": ORDER_HASH,
            },
        })
        self.assertTrue(bridge.get_dashboard()["pending"]["order"]["paymentReceived"])
        self.write_json(bridge.META_FILE_PATH, {
            "pendingOrder": {
                "paymentHash": "e" * 64, "orderId": "o2", "privateKey": order_priv,
                "publicKey": order_pub, "targetNode": "lnd", "serverId": "us-east",
                "createdAt": self.iso(self.now), "paymentReceivedFor": ORDER_HASH,
            },
        })
        self.assertFalse(bridge.get_dashboard()["pending"]["order"]["paymentReceived"])

    def test_state_of_a_previous_key_is_not_shown(self):
        _, pub, _ = self.configure("lnd")
        _, old_pub = new_keypair()
        self.write_json(bridge.META_FILE_PATH, {
            "publicKey": old_pub, "expiresAt": self.iso(self.now + timedelta(days=9)),
            "expirySource": "api", "syncSuccess": True, "bandwidth_used_gb": 77.0,
            "pendingOrder": {
                "paymentHash": ORDER_HASH, "publicKey": pub, "targetNode": "lnd",
                "createdAt": self.iso(self.now),
            },
            "pendingRenewal": {
                "paymentHash": RENEW_HASH, "publicKey": old_pub, "targetNode": "lnd",
                "createdAt": self.iso(self.now),
            },
            "pendingReset": {
                "paymentHash": RESET_HASH, "publicKey": old_pub, "targetNode": "lnd",
                "createdAt": self.iso(self.now),
            },
        })
        self.write_json(bridge.NOTICES_FILE_PATH, {"publicKey": old_pub, "sent": ["7d", "3d"],
                                                   "unknownKey": old_pub})
        model = bridge.get_dashboard()
        self.assertEqual(model["connection"]["publicKey"], pub)
        self.assertIsNone(model["subscription"]["expiresAt"])
        self.assertFalse(model["subscription"]["active"])
        self.assertIsNone(model["bandwidth"]["usedGb"])
        self.assertIsNone(model["pending"]["order"])
        self.assertIsNone(model["pending"]["renewal"])
        self.assertIsNone(model["pending"]["reset"])
        self.assertEqual(model["notices"], {"sent": [], "unknownKey": False})

    def test_key_unknown_is_reported(self):
        _, pub, _ = self.configure("cln")
        self.write_json(bridge.META_FILE_PATH, {
            "publicKey": pub, "keyUnknown": True, "syncSuccess": False,
            "syncError": bridge.UNKNOWN_KEY_MESSAGE,
        })
        self.write_json(bridge.NOTICES_FILE_PATH, {"publicKey": pub, "unknownKey": pub})
        model = bridge.get_dashboard()
        self.assertEqual(model["status"], "unknown_key")
        self.assertTrue(model["subscription"]["keyUnknown"])
        self.assertEqual(model["subscription"]["syncError"], bridge.UNKNOWN_KEY_MESSAGE)
        self.assertEqual(model["targetNode"], "cln")
        self.assertTrue(model["notices"]["unknownKey"])

    def test_malformed_files_are_sanitized(self):
        _, pub, _ = self.configure("lnd")
        self.write_json(bridge.APP_CONFIG_PATH, {"enabled": True, "target-node": "../../etc"})
        self.write_json(bridge.META_FILE_PATH, {
            "publicKey": pub,
            "bandwidth_used_gb": "12",
            "pendingOrder": "not-an-object",
            "pendingRenewal": {"paymentHash": "", "publicKey": pub, "targetNode": "lnd"},
            "pendingReset": {
                "paymentHash": RESET_HASH, "publicKey": pub, "targetNode": "evil",
                "createdAt": "yesterday", "amountSats": True, "lastError": "x" * 5000,
                "expiresAt": 12,
            },
        })
        self.write_json(bridge.HANDOFF_FILE_PATH, {
            "activeTarget": "rm -rf", "pendingOff": ["lnd", "lnd", "bitcoind", 3], "unraised": "eclair",
        })
        with open(bridge.NOTICES_FILE_PATH, "w") as f:
            f.write("{not json")
        model = bridge.get_dashboard()
        self.assertEqual(model["targetNode"], "lnd")
        self.assertIsNone(model["bandwidth"]["usedGb"])
        self.assertIsNone(model["pending"]["order"])
        self.assertIsNone(model["pending"]["renewal"])
        reset = model["pending"]["reset"]
        self.assertIsNone(reset["targetNode"])
        self.assertIsNone(reset["createdAt"])
        self.assertIsNone(reset["amountSats"])
        self.assertIsNone(reset["expiresAt"])
        self.assertEqual(len(reset["lastError"]), bridge.DASHBOARD_TEXT_LIMIT)
        self.assertEqual(model["handoff"], {"activeTarget": None, "pendingOff": ["lnd"], "unraised": []})
        self.assertIsNone(model["notices"])

    def test_version_is_the_package_version_and_absent_when_unknown(self):
        self.configure("lnd")
        with open(os.path.join(os.path.dirname(__file__), "..", "version.json")) as f:
            semver = json.load(f)["semver"]
        with patch.dict(os.environ):
            os.environ.pop("PACKAGE_VERSION", None)
            self.addCleanup(setattr, bridge, "_package_version_cache", None)
            bridge._package_version_cache = None
            self.assertEqual(bridge.get_dashboard()["version"], semver)
            bridge._package_version_cache = None
            with patch.object(bridge, "VERSION_JSON_PATH", os.path.join(self._tmp.name, "version.json")):
                # Never a guessed version: the dashboard footer stays empty.
                self.assertIsNone(bridge.get_dashboard()["version"])


class LoopbackServerTestBase(DashboardStateTestBase):
    """The real handler behind a real HTTP server on loopback."""

    def setUp(self):
        super().setUp()
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), bridge.DashboardHTTPRequestHandler)
        self._thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self._thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        super().tearDown()

    def get(self, path, headers=None):
        # http.client, not urllib: tests patch urllib.request.urlopen to prove
        # the server makes no outbound call.
        conn = http.client.HTTPConnection("127.0.0.1", self.server.server_address[1], timeout=5)
        try:
            conn.request("GET", path, headers=headers or {})
            res = conn.getresponse()
            return res.status, dict(res.getheaders()), res.read()
        finally:
            conn.close()

    def post(self, path, body=b"{}", headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.server.server_address[1], timeout=5)
        try:
            conn.request("POST", path, body=body, headers=headers or {})
            res = conn.getresponse()
            return res.status, dict(res.getheaders()), res.read()
        finally:
            conn.close()

    def head(self, path, headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.server.server_address[1], timeout=5)
        try:
            conn.request("HEAD", path, headers=headers or {})
            res = conn.getresponse()
            return res.status, dict(res.getheaders()), res.read()
        finally:
            conn.close()

    def assert_security_headers(self, headers):
        self.assertEqual(headers.get("Content-Security-Policy"), bridge.DASHBOARD_CSP)
        self.assertIn("frame-ancestors 'none'", headers.get("Content-Security-Policy", ""))
        self.assertEqual(headers.get("X-Content-Type-Options"), "nosniff")
        self.assertEqual(headers.get("Referrer-Policy"), "no-referrer")


class TestDashboardEndpoint(LoopbackServerTestBase):
    def test_get_dashboard_returns_the_read_model(self):
        priv, pub, _ = self.configure("eclair")
        status, headers, body = self.get("/api/dashboard")
        self.assertEqual(status, 200)
        self.assertEqual(headers["Content-Type"], "application/json")
        self.assertEqual(headers["Cache-Control"], "no-store")
        self.assert_security_headers(headers)
        model = json.loads(body)
        self.assertEqual(model["targetNode"], "eclair")
        self.assertEqual(model["connection"]["publicKey"], pub)
        self.assertNotIn(priv, body.decode())
        self.assertEqual(forbidden_keys(model), [])

    def test_get_dashboard_rejects_untrusted_hosts(self):
        status, headers, _ = self.get("/api/dashboard", {"Host": "attacker.example"})
        self.assertEqual(status, 403)
        self.assert_security_headers(headers)
        status, _, _ = self.get("/api/dashboard", {"Origin": "https://attacker.example"})
        self.assertEqual(status, 403)
        status, _, _ = self.get("/", {"Host": "attacker.example"})
        self.assertEqual(status, 403)

    def test_get_dashboard_never_syncs(self):
        self.configure("lnd")
        with patch("bridge.lazy_sync") as sync, patch("urllib.request.urlopen") as urlopen:
            # The server thread shares the patched module attributes.
            status, _, _ = self.get("/api/dashboard?force=1")
        self.assertEqual(status, 200)
        sync.assert_not_called()
        urlopen.assert_not_called()

    def test_static_assets_and_security_headers(self):
        for path, expected_type in (
            ("/", "text/html; charset=utf-8"),
            ("/script.js", "application/javascript"),
            ("/style.css", "text/css"),
        ):
            with self.subTest(path=path):
                status, headers, body = self.get(path)
                self.assertEqual(status, 200)
                self.assertEqual(headers.get("Content-Type"), expected_type)
                self.assert_security_headers(headers)
                self.assertGreater(len(body), 0)

        status, headers, _ = self.get("/qrcode.js")
        self.assertEqual(status, 404)
        self.assert_security_headers(headers)

        status, headers, body = self.get("/../bridge.py")
        self.assertEqual(status, 403)
        self.assert_security_headers(headers)
        self.assertNotIn(b"DashboardHTTPRequestHandler", body)

    def test_removed_post_routes_return_404_over_http(self):
        csrf_headers = {
            "Content-Type": "application/json",
            "X-CSRF-Token": bridge.get_csrf_token(),
        }
        for path in ("/api/keys/generate", "/api/config/save"):
            with self.subTest(path=path):
                status, headers, _ = self.post(path, body=b'{"target_node":"lnd"}', headers=csrf_headers)
                self.assertEqual(status, 404)
                self.assert_security_headers(headers)

    def test_post_intents_csrf_and_validation(self):
        self.configure("lnd")
        csrf_headers = {
            "Content-Type": "application/json",
            "X-CSRF-Token": bridge.get_csrf_token(),
        }
        # Missing CSRF token -> 403
        status, headers, _ = self.post(
            "/api/intents",
            body=b'{"kind":"reset"}',
            headers={"Content-Type": "application/json"},
        )
        self.assertEqual(status, 403)
        self.assert_security_headers(headers)

        # Arbitrary extra keys, bad kind, bad serverId, bad duration -> 400
        for bad_payload in (
            {"kind": "unknown"},
            {"kind": "buy", "serverId": "eu-de", "duration": "3m", "privateKey": "leak"},
            {"kind": "buy", "serverId": "../evil", "duration": "3m"},
            {"kind": "buy", "serverId": "eu-de", "duration": "99m"},
            {"kind": "renew", "duration": "3m", "extra": 1},
            {"kind": "reset", "duration": "1m"},
        ):
            with self.subTest(payload=bad_payload):
                status, headers, body = self.post(
                    "/api/intents",
                    body=json.dumps(bad_payload).encode(),
                    headers=csrf_headers,
                )
                self.assertEqual(status, 400)
                self.assert_security_headers(headers)
                self.assertIn("error", json.loads(body))

    def test_post_intents_requires_configured_key_for_renew_and_reset(self):
        csrf_headers = {
            "Content-Type": "application/json",
            "X-CSRF-Token": bridge.get_csrf_token(),
        }
        for payload in ({"kind": "renew", "duration": "3m"}, {"kind": "reset"}):
            with self.subTest(payload=payload):
                status, _, body = self.post(
                    "/api/intents",
                    body=json.dumps(payload).encode(),
                    headers=csrf_headers,
                )
                self.assertEqual(status, 409)
                self.assertIn("before a WireGuard configuration is installed", json.loads(body)["error"])

    def test_post_intents_queues_even_with_a_payable_invoice(self):
        """Reuse, conflict or replacement is decided by the shared action core
        in the runner; the bridge queues the request, so an identical
        request also re-raises a Pay Invoice task that failed to raise."""
        _, pub, _ = self.configure("lnd")
        order_priv, order_pub = new_keypair()
        self.write_json(bridge.META_FILE_PATH, {
            "publicKey": pub,
            "pendingOrder": {
                "paymentHash": ORDER_HASH, "orderId": "order-1", "privateKey": order_priv,
                "publicKey": order_pub, "targetNode": "lnd", "serverId": "eu-de",
                "duration": 3, "createdAt": self.iso(self.now), "invoice": ORDER_INVOICE,
            },
        })
        csrf_headers = {
            "Content-Type": "application/json",
            "X-CSRF-Token": bridge.get_csrf_token(),
        }
        status, headers, body = self.post(
            "/api/intents",
            body=json.dumps({"kind": "buy", "serverId": "eu-de", "duration": "3m"}).encode(),
            headers=csrf_headers,
        )
        self.assertEqual(status, 202)
        self.assert_security_headers(headers)
        data = json.loads(body)
        self.assertEqual(data["status"], "accepted")
        self.assertEqual(forbidden_keys(data), [])
        with open(bridge.INTENTS_FILE_PATH) as f:
            self.assertEqual(json.load(f)["buy"]["serverId"], "eu-de")
        # The payable invoice itself stays visible for scan/copy.
        _, _, dash_body = self.get("/api/dashboard")
        self.assertEqual(json.loads(dash_body)["pending"]["order"]["invoice"], ORDER_INVOICE)

    def test_post_intents_writes_slot_and_rate_limits_repeats(self):
        _, pub, _ = self.configure("lnd")
        csrf_headers = {
            "Content-Type": "application/json",
            "X-CSRF-Token": bridge.get_csrf_token(),
        }
        status, headers, body = self.post(
            "/api/intents",
            body=json.dumps({"kind": "buy", "serverId": "eu-de", "duration": "3m"}).encode(),
            headers=csrf_headers,
        )
        self.assertEqual(status, 202)
        self.assert_security_headers(headers)
        resp = json.loads(body)
        self.assertEqual(resp["status"], "accepted")
        intent_id = resp["intent"]["id"]
        self.assertEqual(resp["intent"]["status"], "pending")

        # Immediate repeat of 'buy' is rejected with 429
        status2, _, body2 = self.post(
            "/api/intents",
            body=json.dumps({"kind": "buy", "serverId": "eu-de", "duration": "3m"}).encode(),
            headers=csrf_headers,
        )
        self.assertEqual(status2, 429)
        self.assertIn("retryAfterSeconds", json.loads(body2))

        # Simulate TypeScript intentRunner completing the intent
        self.write_json(bridge.INTENT_RESULTS_FILE_PATH, {
            "buy": {
                "id": intent_id,
                "kind": "buy",
                "status": "succeeded",
                "createdAt": resp["intent"]["createdAt"],
                "updatedAt": self.iso(self.now + timedelta(seconds=2)),
            }
        })
        _, _, dash_body = self.get("/api/dashboard")
        dash = json.loads(dash_body)
        self.assertEqual(dash["intents"]["buy"]["id"], intent_id)
        self.assertEqual(dash["intents"]["buy"]["status"], "succeeded")
        self.assertEqual(forbidden_keys(dash), [])

        # Repeat within 30s is still rejected by per-kind cooldown even after completion
        status3, _, _ = self.post(
            "/api/intents",
            body=json.dumps({"kind": "buy", "serverId": "us-east", "duration": "6m"}).encode(),
            headers=csrf_headers,
        )
        self.assertEqual(status3, 429)

    def test_submit_intent_hourly_cap_and_ttl_expiry(self):
        self.configure("lnd")
        base_t = self.now - timedelta(minutes=30)
        for i in range(bridge.INTENT_HOURLY_CAP):
            t = base_t + timedelta(minutes=i * 2)
            code, res = bridge.submit_dashboard_intent(
                {"kind": "reset"},
                now=t,
            )
            self.assertEqual(code, 202)
            # Mark succeeded so the next submission 2 minutes later is not blocked as in-flight
            self.write_json(bridge.INTENT_RESULTS_FILE_PATH, {
                "reset": {
                    "id": res["intent"]["id"],
                    "kind": "reset",
                    "status": "succeeded",
                    "createdAt": res["intent"]["createdAt"],
                    "updatedAt": self.iso(t + timedelta(seconds=1)),
                }
            })

        # 6th submission within the hour hits the 5/hour cap
        code, res = bridge.submit_dashboard_intent(
            {"kind": "renew", "duration": "1m"},
            now=base_t + timedelta(minutes=20),
        )
        self.assertEqual(code, 429)
        self.assertIn("Too many payment requests", res["error"])

        # An unanswered intent older than INTENT_TTL (120s) is reported as failed in _intents_summary
        self.write_json(bridge.INTENTS_FILE_PATH, {
            "buy": {
                "id": "buy-stale-1",
                "kind": "buy",
                "createdAt": self.iso(self.now - timedelta(seconds=150)),
                "serverId": "eu-de",
                "duration": "1m",
            }
        })
        summary = bridge._intents_summary(now=self.now)
        self.assertEqual(summary["buy"]["status"], "failed")
        self.assertIn("timed out", summary["buy"]["error"])

    def test_buy_slot_carries_configured_node_and_wire_format(self):
        self.write_json(bridge.APP_CONFIG_PATH, {"enabled": False, "target-node": "cln"})
        code, res = bridge.submit_dashboard_intent(
            {"kind": "buy", "serverId": "eu-ch", "duration": "6m"}, now=self.now,
        )
        self.assertEqual(code, 202)
        with open(bridge.INTENTS_FILE_PATH) as f:
            slot = json.load(f)["buy"]
        # The exact shape startos/fileModels/dashboardIntents.ts parses.
        self.assertEqual(slot["kind"], "buy")
        self.assertEqual(slot["serverId"], "eu-ch")
        self.assertEqual(slot["duration"], "6m")
        self.assertEqual(slot["targetNode"], "cln")
        self.assertEqual(bridge._intents_summary(now=self.now)["buy"]["targetNode"], "cln")

        # Durations stay strict on the wire: whole months are not accepted.
        code, _ = bridge.submit_dashboard_intent(
            {"kind": "renew", "duration": 3}, now=self.now,
        )
        self.assertEqual(code, 400)

    def test_processing_intent_is_not_timed_out_by_the_bridge(self):
        """Only the runner records the outcome of a request it picked up (it
        re-runs a processing slot after a restart), so the bridge never
        reports a processing request as failed while its action may run."""
        created = self.now - bridge.INTENT_TTL - timedelta(hours=1)
        self.write_json(bridge.INTENTS_FILE_PATH, {
            "reset": {"id": "reset-1", "kind": "reset", "createdAt": self.iso(created)},
        })
        self.write_json(bridge.INTENT_RESULTS_FILE_PATH, {
            "reset": {
                "id": "reset-1", "kind": "reset", "status": "processing",
                "createdAt": self.iso(created), "updatedAt": self.iso(created),
            },
        })
        self.assertEqual(bridge._intents_summary(now=self.now)["reset"]["status"], "processing")

    def test_a_failed_intent_is_reported_for_a_limited_time(self):
        """A failure answers the click that caused it. The read model reports
        it for INTENT_FAILURE_SHOWN_FOR after it failed (this box's clock, as
        for INTENT_TTL) and then shows no request of that kind, so an old
        failure does not greet every later visit."""
        error = "Maximum 2 bandwidth resets per month reached"

        def reset_failed_at(failed_at):
            created = failed_at - timedelta(seconds=5)
            self.write_json(bridge.INTENTS_FILE_PATH, {
                "reset": {"id": "reset-1", "kind": "reset", "createdAt": self.iso(created)},
            })
            self.write_json(bridge.INTENT_RESULTS_FILE_PATH, {
                "reset": {
                    "id": "reset-1", "kind": "reset", "status": "failed",
                    "createdAt": self.iso(created), "updatedAt": self.iso(failed_at),
                    "error": error,
                },
            })
            return bridge._intents_summary(now=self.now)["reset"]

        shown_for = bridge.INTENT_FAILURE_SHOWN_FOR
        recent = reset_failed_at(self.now - shown_for + timedelta(seconds=1))
        self.assertEqual((recent["status"], recent["error"]), ("failed", error))
        self.assertIsNone(reset_failed_at(self.now - shown_for))

        # A request the runner never picked up fails at INTENT_TTL; it is
        # dropped the same time after it was made.
        os.remove(bridge.INTENT_RESULTS_FILE_PATH)
        self.write_json(bridge.INTENTS_FILE_PATH, {
            "buy": {"id": "buy-1", "kind": "buy", "serverId": "eu-de", "duration": "1m",
                    "createdAt": self.iso(self.now - shown_for)},
        })
        self.assertIsNone(bridge._intents_summary(now=self.now)["buy"])

        # Only failures age out: an old success is still reported.
        long_ago = self.iso(self.now - shown_for - timedelta(hours=1))
        self.write_json(bridge.INTENTS_FILE_PATH, {
            "renew": {"id": "renew-1", "kind": "renew", "duration": "1m", "createdAt": long_ago},
        })
        self.write_json(bridge.INTENT_RESULTS_FILE_PATH, {
            "renew": {"id": "renew-1", "kind": "renew", "status": "succeeded",
                      "createdAt": long_ago, "updatedAt": long_ago},
        })
        self.assertEqual(bridge._intents_summary(now=self.now)["renew"]["status"], "succeeded")

        # The next request of that kind is accepted as usual.
        self.configure("lnd")
        reset_failed_at(self.now - shown_for)
        code, _ = bridge.submit_dashboard_intent({"kind": "reset"}, now=self.now)
        self.assertEqual(code, 202)


class TestStaticServingHardening(LoopbackServerTestBase):
    """Static files over the real handler: odd paths always get an answer."""

    def raw_get(self, raw_path):
        # http.client refuses control characters in a URL, so speak HTTP over
        # a plain socket to send exactly these bytes.
        port = self.server.server_address[1]
        with socket.create_connection(("127.0.0.1", port), timeout=5) as sock:
            sock.sendall(b"GET " + raw_path + b" HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
            chunks = []
            while True:
                chunk = sock.recv(65536)
                if not chunk:
                    break
                chunks.append(chunk)
        head, _, body = b"".join(chunks).partition(b"\r\n\r\n")
        return head.split(b"\r\n"), body

    def test_control_characters_in_the_path_get_a_400_with_security_headers(self):
        # A NUL byte used to make os.path.realpath raise, so the connection
        # was dropped without any response.
        for raw_path in (b"/\x00", b"/index.html\x00.png", b"/style.css\x01", b"/script.js\x7f"):
            with self.subTest(raw_path=raw_path):
                head, _ = self.raw_get(raw_path)
                self.assertRegex(head[0], rb"^HTTP/1\.[01] 400 ")
                self.assertIn(b"Content-Security-Policy: " + bridge.DASHBOARD_CSP.encode(), head)
                self.assertIn(b"X-Content-Type-Options: nosniff", head)
                self.assertIn(b"Referrer-Policy: no-referrer", head)

    def test_trailing_slash_paths_are_not_served(self):
        # "/index.html/" used to serve the page at a path where every
        # relative asset URL resolves below a file.
        for path in ("/index.html/", "/style.css/", "/fonts/", "/icons/"):
            with self.subTest(path=path):
                status, headers, _ = self.get(path)
                self.assertEqual(status, 404)
                self.assert_security_headers(headers)

    def test_traversal_stays_inside_the_web_directory(self):
        for path, expected in (
            ("/../bridge.py", 403),
            ("/fonts/../../bridge.py", 403),
            # Paths are not percent-decoded: an encoded dot-dot is a missing file.
            ("/%2e%2e/bridge.py", 404),
            ("/..%2fbridge.py", 404),
        ):
            with self.subTest(path=path):
                status, headers, body = self.get(path)
                self.assertEqual(status, expected)
                self.assert_security_headers(headers)
                self.assertNotIn(b"DashboardHTTPRequestHandler", body)

    def test_static_assets_are_served_with_their_mime_types(self):
        for path, expected_type in (
            ("/fonts/inter-latin-wght-normal.woff2", "font/woff2"),
            ("/fonts/jetbrains-mono-latin-wght-normal.woff2", "font/woff2"),
            ("/fonts/LICENSE-Inter.txt", "text/plain; charset=utf-8"),
            ("/favicon.svg", "image/svg+xml"),
            ("/icons/connected.png", "image/png"),
        ):
            with self.subTest(path=path):
                status, headers, body = self.get(path)
                self.assertEqual(status, 200)
                self.assertEqual(headers.get("Content-Type"), expected_type)
                self.assert_security_headers(headers)
                self.assertGreater(len(body), 0)

    def test_head_requests_and_cache_validators(self):
        self.configure("lnd")
        for path in ("/", "/style.css", "/script.js", "/favicon.svg"):
            with self.subTest(path=path):
                get_status, get_headers, get_body = self.get(path)
                self.assertEqual(get_status, 200)
                self.assertGreater(len(get_body), 0)
                etag = get_headers.get("ETag")
                last_mod = get_headers.get("Last-Modified")
                self.assertTrue(etag and etag.startswith('"') and etag.endswith('"'))
                self.assertTrue(last_mod)
                self.assertEqual(get_headers.get("Content-Length"), str(len(get_body)))

                # HEAD returns identical validator and length headers with an empty body
                head_status, head_headers, head_body = self.head(path)
                self.assertEqual(head_status, 200)
                self.assertEqual(head_body, b"")
                self.assert_security_headers(head_headers)
                self.assertEqual(head_headers.get("ETag"), etag)
                self.assertEqual(head_headers.get("Last-Modified"), last_mod)
                self.assertEqual(head_headers.get("Content-Length"), str(len(get_body)))

                # If-None-Match matching (exact, weak W/, and comma-separated list) -> 304
                for inm in (etag, f"W/{etag}", f'"other", {etag}'):
                    status_304, headers_304, body_304 = self.get(path, {"If-None-Match": inm})
                    self.assertEqual(status_304, 304)
                    self.assertEqual(body_304, b"")
                    self.assert_security_headers(headers_304)
                    self.assertEqual(headers_304.get("ETag"), etag)

                # Non-matching If-None-Match -> 200 (even if If-Modified-Since matches)
                status_200, _, body_200 = self.get(
                    path,
                    {"If-None-Match": '"stale"', "If-Modified-Since": last_mod},
                )
                self.assertEqual(status_200, 200)
                self.assertEqual(len(body_200), len(get_body))

                # If-Modified-Since matching (when If-None-Match is absent) -> 304
                status_ims, headers_ims, body_ims = self.get(path, {"If-Modified-Since": last_mod})
                self.assertEqual(status_ims, 304)
                self.assertEqual(body_ims, b"")
                self.assertEqual(headers_ims.get("Last-Modified"), last_mod)

        # HEAD on /api/dashboard returns 200 with no-store and empty body
        dash_status, dash_headers, dash_body = self.head("/api/dashboard")
        self.assertEqual(dash_status, 200)
        self.assertEqual(dash_body, b"")
        self.assertEqual(dash_headers.get("Cache-Control"), "no-store")
        self.assert_security_headers(dash_headers)


if __name__ == "__main__":
    unittest.main()
