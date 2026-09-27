"""Settlement watcher: finishes a paid Buy or Renew without any step outside
StartOS.

A Buy leaves `pendingOrder` (with the on-box private key) in the metadata; a
Renew leaves `pendingRenewal`. Each `settle_pending` tick polls the TunnelSats
API for them. A paid order is claimed with the on-box public key; the config
is assembled locally from the structured claim fields and the local private
key. Anything the server sends that could carry key material (`fullConfig`,
`config`, `peer.privateKey`) is ignored, and incomplete or unsafe fields fail
closed without touching the pending order or its key.
"""
import io
import json
import os
import sys
import tempfile
import types
import unittest
import urllib.error
from contextlib import redirect_stdout
from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock, patch

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))
import bridge

NOW = datetime(2026, 9, 26, 12, 0, 0, tzinfo=timezone.utc)
HASH = "a" * 64
RENEW_HASH = "b" * 64
ORDER_TASK = "tunnelsats-order:eclair:" + HASH[:16]
RENEW_TASK = "tunnelsats-renewal:cln:" + RENEW_HASH[:16]
SERVER_PUB = "c2VydmVyLXB1YmtleS1zZXJ2ZXItcHVia2V5LXNlcnY="
PSK = "cHNrLXBzay1wc2stcHNrLXBzay1wc2stcHNrLXBzay0="
OTHER_PUB = "7v4SSOfHG0qjHArLrDucmKCpkgHE+hH6DzZFSoq5JVk="
SERVER_PRIV = "U0VSVkVSLVBSSVZBVEUtS0VZLVNFUlZFUi1QUklWQVQ="


def iso(dt):
    return dt.isoformat().replace("+00:00", "Z")


def response(payload, status=200):
    resp = MagicMock()
    resp.status = status
    resp.read.return_value = json.dumps(payload).encode()
    resp.__enter__ = lambda s: s
    resp.__exit__ = MagicMock(return_value=False)
    return resp


def http_error(url, code, payload):
    return urllib.error.HTTPError(url, code, "error", {}, io.BytesIO(json.dumps(payload).encode()))


class FakeApi:
    """Routes urllib requests by method and path; records every request."""

    def __init__(self):
        self.routes = {}
        self.requests = []

    def on(self, method, path, handler):
        self.routes[(method, path)] = handler

    def __call__(self, req, timeout=None):
        path = req.full_url.split("/api/public/v1", 1)[1]
        body = json.loads(req.data.decode()) if req.data else None
        self.requests.append((req.get_method(), path, body))
        handler = self.routes.get((req.get_method(), path))
        if handler is None:
            raise http_error(req.full_url, 404, {"error": "ERR_RESOURCE_NOT_FOUND"})
        # Handlers are canned responses/errors or functions of the request body
        # (a MagicMock response is callable too, so test for functions).
        result = handler(body) if isinstance(handler, types.FunctionType) else handler
        if isinstance(result, Exception):
            raise result
        return result


class SettlementTestBase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        d = self._tmp.name
        self._orig = (bridge.META_FILE_PATH, bridge.CONFIG_PATH, bridge.APP_CONFIG_PATH)
        bridge.META_FILE_PATH = os.path.join(d, "tunnelsats-meta.json")
        bridge.CONFIG_PATH = os.path.join(d, "tunnelsatsv3.conf")
        bridge.APP_CONFIG_PATH = os.path.join(d, "config.json")
        bridge._pubkey_cache = None
        self.priv, self.pub = bridge.generate_wg_keypair()
        self.api = FakeApi()
        self._urlopen = patch("urllib.request.urlopen", side_effect=self.api)
        self._urlopen.start()
        # lazy_sync retries transient errors with a sleep; never sleep in tests.
        self._sleep = patch("bridge.time.sleep")
        self._sleep.start()

    def tearDown(self):
        self._sleep.stop()
        self._urlopen.stop()
        bridge.META_FILE_PATH, bridge.CONFIG_PATH, bridge.APP_CONFIG_PATH = self._orig
        bridge._pubkey_cache = None
        self._tmp.cleanup()

    def write_meta(self, meta):
        with open(bridge.META_FILE_PATH, "w") as f:
            json.dump(meta, f)

    def read_meta(self):
        with open(bridge.META_FILE_PATH) as f:
            return json.load(f)

    def pending_order(self, **overrides):
        order = {
            "paymentHash": HASH,
            "orderId": "order-1",
            "privateKey": self.priv,
            "publicKey": self.pub,
            "targetNode": "eclair",
            "serverId": "eu-de",
            "createdAt": iso(NOW - timedelta(minutes=5)),
        }
        order.update(overrides)
        return order

    def claim_payload(self, **overrides):
        payload = {
            "status": "success",
            "subscriptionEnd": "2026-10-26T12:00:00.000Z",
            "server": {"endpoint": "de2.tunnelsats.com:51820", "publicKey": SERVER_PUB,
                       "allowedIPs": "0.0.0.0/0, ::/0"},
            "peer": {"address": "10.9.0.7", "publicKey": self.pub, "presharedKey": PSK},
            "vpnPort": 24556,
            "fullConfig": None,
        }
        payload.update(overrides)
        return payload

    def settle(self, now=NOW):
        return bridge.settle_pending(now=now)

    def only(self, result):
        self.assertEqual(len(result["outcomes"]), 1, result)
        return result["outcomes"][0]


class TestOrderSettlement(SettlementTestBase):
    def test_idle_without_pending_state(self):
        self.write_meta({"expiresAt": "2026-12-01T00:00:00Z"})
        result = self.settle()
        self.assertEqual(result["outcomes"], [])
        self.assertEqual(result["clearPayTasks"], [])
        self.assertEqual(self.api.requests, [])

    def test_unpaid_order_keeps_waiting(self):
        self.write_meta({"pendingOrder": self.pending_order()})
        self.api.on("GET", f"/subscription/{HASH}", response({"status": "unpaid"}))
        outcome = self.only(self.settle())
        self.assertEqual((outcome["kind"], outcome["result"]), ("order", "waiting"))
        self.assertEqual(self.read_meta()["pendingOrder"]["privateKey"], self.priv)

    def test_order_being_provisioned_keeps_waiting(self):
        self.write_meta({"pendingOrder": self.pending_order()})
        self.api.on("GET", f"/subscription/{HASH}", response({"status": "processing"}, status=202))
        self.assertEqual(self.only(self.settle())["result"], "waiting")

    def test_paid_order_is_claimed_with_the_local_key_and_provisioned(self):
        self.write_meta({"pendingOrder": self.pending_order(), "syncError": "old"})
        self.api.on("GET", f"/subscription/{HASH}", response({"status": "paid"}))
        self.api.on("POST", "/subscription/claim", response(self.claim_payload()))

        result = self.settle()
        outcome = self.only(result)

        self.assertEqual((outcome["kind"], outcome["result"]), ("order", "provisioned"))
        claim_body = self.api.requests[-1][2]
        self.assertEqual(claim_body, {"paymentHash": HASH, "wgPublicKey": self.pub})
        with open(bridge.CONFIG_PATH) as f:
            conf = f.read()
        self.assertIn(f"PrivateKey = {self.priv}\n", conf)
        self.assertIn("Address = 10.9.0.7\n", conf)
        self.assertIn(f"PublicKey = {SERVER_PUB}\n", conf)
        self.assertIn(f"PresharedKey = {PSK}\n", conf)
        self.assertIn("Endpoint = de2.tunnelsats.com:51820\n", conf)
        self.assertIn("# Port Forwarding: 24556\n", conf)
        self.assertIn("# inbound: yes\n", conf)
        self.assertEqual(bridge.get_wg_pubkey(), self.pub)
        with open(bridge.APP_CONFIG_PATH) as f:
            app = json.load(f)
        self.assertEqual((app["enabled"], app["target-node"]), (True, "eclair"))
        meta = self.read_meta()
        self.assertNotIn("pendingOrder", meta)
        self.assertEqual(meta["vpnPort"], 24556)
        self.assertEqual(meta["payTasksToClear"], [ORDER_TASK])
        self.assertEqual(result["clearPayTasks"], [ORDER_TASK])

    def test_server_supplied_config_and_private_keys_are_never_used(self):
        self.write_meta({"pendingOrder": self.pending_order()})
        self.api.on("GET", f"/subscription/{HASH}", response({"status": "paid"}))
        payload = self.claim_payload(
            status="already_processed",
            fullConfig=f"[Interface]\nPrivateKey = {SERVER_PRIV}\n",
            config=f"[Interface]\nPrivateKey = {SERVER_PRIV}\n",
        )
        payload["peer"]["privateKey"] = SERVER_PRIV
        self.api.on("POST", "/subscription/claim", response(payload))

        self.assertEqual(self.only(self.settle())["result"], "provisioned")
        with open(bridge.CONFIG_PATH) as f:
            conf = f.read()
        self.assertNotIn(SERVER_PRIV, conf)
        self.assertIn(f"PrivateKey = {self.priv}\n", conf)

    def assert_fails_closed(self, payload, expected_error):
        self.write_meta({"pendingOrder": self.pending_order()})
        self.api.on("GET", f"/subscription/{HASH}", response({"status": "paid"}))
        self.api.on("POST", "/subscription/claim", response(payload))

        outcome = self.only(self.settle())

        self.assertEqual(outcome["result"], "failed")
        self.assertIn(expected_error, outcome["message"])
        self.assertFalse(os.path.exists(bridge.CONFIG_PATH))
        pending = self.read_meta()["pendingOrder"]
        self.assertEqual(pending["privateKey"], self.priv)
        self.assertIn(expected_error, pending["lastError"])
        self.assertEqual(pending["nextAttemptAt"], iso(NOW + timedelta(minutes=5)))

    def test_claim_for_another_key_fails_closed(self):
        payload = self.claim_payload()
        payload["peer"]["publicKey"] = OTHER_PUB
        self.assert_fails_closed(payload, "different WireGuard key")

    def test_claim_without_key_echo_fails_closed(self):
        # The pre-fix backend: already_processed with a server-key config and
        # no structured fields.
        self.assert_fails_closed(
            {"status": "already_processed", "config": f"PrivateKey = {SERVER_PRIV}", "server": None},
            "different WireGuard key",
        )

    def test_claim_without_integer_vpn_port_fails_closed(self):
        for bad in (None, "24556", True, 0, 70000):
            with self.subTest(vpnPort=bad):
                self.assert_fails_closed(self.claim_payload(vpnPort=bad), "vpnPort")

    def test_claim_fields_that_could_inject_config_lines_fail_closed(self):
        cases = {
            "endpoint": ("server", "endpoint", "de2.tunnelsats.com:51820\nPostUp = touch /tmp/pwned"),
            "server publicKey": ("server", "publicKey", SERVER_PUB + "\nPostUp = id"),
            "address": ("peer", "address", "10.9.0.7\nDNS = 1.1.1.1"),
            "presharedKey": ("peer", "presharedKey", "not-a-key"),
            "allowedIPs": ("server", "allowedIPs", "0.0.0.0/0\nPostUp = id"),
        }
        for label, (section, field, value) in cases.items():
            with self.subTest(field=label):
                payload = self.claim_payload()
                payload[section][field] = value
                self.assert_fails_closed(payload, label)

    def test_local_private_key_must_match_the_registered_public_key(self):
        _, unrelated_pub = bridge.generate_wg_keypair()
        self.write_meta({"pendingOrder": self.pending_order(publicKey=unrelated_pub)})
        self.api.on("GET", f"/subscription/{HASH}", response({"status": "paid"}))
        payload = self.claim_payload()
        payload["peer"]["publicKey"] = unrelated_pub
        self.api.on("POST", "/subscription/claim", response(payload))

        outcome = self.only(self.settle())

        self.assertEqual(outcome["result"], "failed")
        self.assertIn("does not match", outcome["message"])
        self.assertFalse(os.path.exists(bridge.CONFIG_PATH))

    def test_claim_still_provisioning_keeps_waiting(self):
        self.write_meta({"pendingOrder": self.pending_order()})
        self.api.on("GET", f"/subscription/{HASH}", response({"status": "paid"}))
        self.api.on("POST", "/subscription/claim", response({"status": "processing"}, status=202))
        self.assertEqual(self.only(self.settle())["result"], "waiting")
        self.assertNotIn("lastError", self.read_meta()["pendingOrder"])

    def test_failure_backs_off_without_calling_the_api(self):
        self.write_meta({"pendingOrder": self.pending_order(
            lastError="HTTP 500 from claim", nextAttemptAt=iso(NOW + timedelta(minutes=3)))})
        outcome = self.only(self.settle())
        self.assertEqual(outcome["result"], "failed")
        self.assertIn("HTTP 500 from claim", outcome["message"])
        self.assertEqual(self.api.requests, [])

    def test_retry_after_backoff_clears_the_error_once_it_waits_again(self):
        self.write_meta({"pendingOrder": self.pending_order(
            lastError="HTTP 500", nextAttemptAt=iso(NOW - timedelta(seconds=1)))})
        self.api.on("GET", f"/subscription/{HASH}", response({"status": "unpaid"}))
        self.assertEqual(self.only(self.settle())["result"], "waiting")
        pending = self.read_meta()["pendingOrder"]
        self.assertNotIn("lastError", pending)
        self.assertNotIn("nextAttemptAt", pending)

    def test_api_errors_are_recorded_as_failures(self):
        self.write_meta({"pendingOrder": self.pending_order()})
        self.api.on("GET", f"/subscription/{HASH}", response({"status": "paid"}))
        self.api.on("POST", "/subscription/claim",
                    http_error("claim", 500, {"message": "Provisioning failed. Please retry the claim."}))
        outcome = self.only(self.settle())
        self.assertEqual(outcome["result"], "failed")
        self.assertIn("HTTP 500", outcome["message"])
        self.assertIn("Provisioning failed", self.read_meta()["pendingOrder"]["lastError"])

    def test_unpaid_order_expires_after_24_hours(self):
        self.write_meta({"pendingOrder": self.pending_order(createdAt=iso(NOW - timedelta(hours=25)))})
        self.api.on("GET", f"/subscription/{HASH}", response({"status": "unpaid"}))
        result = self.settle()
        self.assertEqual(self.only(result)["result"], "expired")
        meta = self.read_meta()
        self.assertNotIn("pendingOrder", meta)
        self.assertEqual(result["clearPayTasks"], [ORDER_TASK])

    def test_unknown_order_expires_only_after_24_hours(self):
        self.write_meta({"pendingOrder": self.pending_order()})
        self.assertEqual(self.only(self.settle())["result"], "failed")
        self.assertIn("pendingOrder", self.read_meta())

        self.write_meta({"pendingOrder": self.pending_order(createdAt=iso(NOW - timedelta(hours=25)))})
        self.assertEqual(self.only(self.settle())["result"], "expired")
        self.assertNotIn("pendingOrder", self.read_meta())

    def test_a_replaced_pending_order_is_not_cleared(self):
        # A new Buy replaced pendingOrder while this tick claimed the old one.
        new_order = self.pending_order(paymentHash="f" * 64, orderId="order-2")

        def claim(_body):
            self.write_meta({"pendingOrder": new_order})
            return response(self.claim_payload())

        self.write_meta({"pendingOrder": self.pending_order()})
        self.api.on("GET", f"/subscription/{HASH}", response({"status": "paid"}))
        self.api.on("POST", "/subscription/claim", claim)

        self.assertEqual(self.only(self.settle())["result"], "provisioned")
        meta = self.read_meta()
        self.assertEqual(meta["pendingOrder"], new_order)
        self.assertNotIn("payTasksToClear", meta)

    def test_a_concurrent_tick_is_skipped(self):
        self.write_meta({"pendingOrder": self.pending_order()})
        with bridge.settle_lock() as acquired:
            self.assertTrue(acquired)
            result = self.settle()
        self.assertTrue(result["busy"])
        self.assertEqual(result["outcomes"], [])
        self.assertEqual(self.api.requests, [])


class TestRenewalSettlement(SettlementTestBase):
    def setUp(self):
        super().setUp()
        conf = (
            "[Interface]\n"
            f"PrivateKey = {self.priv}\n"
            "Address = 10.9.0.7\n"
            "# Port Forwarding: 24556\n"
            "\n[Peer]\n"
            f"PublicKey = {SERVER_PUB}\n"
            "Endpoint = de2.tunnelsats.com:51820\n"
        )
        with open(bridge.CONFIG_PATH, "w") as f:
            f.write(conf)

    def pending_renewal(self, **overrides):
        renewal = {
            "paymentHash": RENEW_HASH,
            "renewalId": "renewal-1",
            "oldExpiry": "2026-10-01T00:00:00.000Z",
            "newExpiry": "2026-11-01T00:00:00.000Z",
            "publicKey": self.pub,
            "targetNode": "cln",
            "createdAt": iso(NOW - timedelta(minutes=5)),
        }
        renewal.update(overrides)
        return renewal

    def test_paid_renewal_is_confirmed_and_cleared(self):
        self.write_meta({"pendingRenewal": self.pending_renewal()})
        self.api.on("GET", f"/subscription/{RENEW_HASH}", response({"status": "paid"}))
        self.api.on("POST", "/subscription/status", response({"expiry": "2026-11-01T00:00:00.000Z"}))

        result = self.settle()

        self.assertEqual(self.only(result)["result"], "renewed")
        meta = self.read_meta()
        self.assertNotIn("pendingRenewal", meta)
        self.assertEqual((meta["expiresAt"], meta["expirySource"]), ("2026-11-01T00:00:00.000Z", "api"))
        self.assertEqual(result["clearPayTasks"], [RENEW_TASK])

    def test_paid_renewal_waits_until_the_confirmed_expiry_moved(self):
        self.write_meta({"pendingRenewal": self.pending_renewal()})
        self.api.on("GET", f"/subscription/{RENEW_HASH}", response({"status": "paid"}))
        self.api.on("POST", "/subscription/status", response({"expiry": "2026-10-01T00:00:00.000Z"}))
        self.assertEqual(self.only(self.settle())["result"], "waiting")
        self.assertIn("pendingRenewal", self.read_meta())

    def test_paid_renewal_for_a_replaced_key_is_just_cleared(self):
        self.write_meta({"pendingRenewal": self.pending_renewal(publicKey=OTHER_PUB)})
        self.api.on("GET", f"/subscription/{RENEW_HASH}", response({"status": "paid"}))
        result = self.settle()
        self.assertEqual(self.only(result)["result"], "superseded")
        self.assertNotIn("pendingRenewal", self.read_meta())
        self.assertEqual(result["clearPayTasks"], [RENEW_TASK])
        self.assertNotIn(("POST", "/subscription/status"), [(m, p) for m, p, _ in self.api.requests])

    def test_unpaid_renewal_expires_after_24_hours(self):
        self.write_meta({"pendingRenewal": self.pending_renewal(createdAt=iso(NOW - timedelta(hours=25)))})
        self.api.on("GET", f"/subscription/{RENEW_HASH}", response({"status": "pending"}))
        self.assertEqual(self.only(self.settle())["result"], "expired")
        self.assertNotIn("pendingRenewal", self.read_meta())

    def test_paid_legacy_renewal_is_never_confirmed_with_the_current_key(self):
        # Recorded by an earlier version: neither the key it was paid for nor
        # its node is known. The configured key's expiry proves nothing
        # about it, so it is released (TunnelSats applies it to its key)
        # instead of being reported as renewed.
        self.write_meta({"pendingRenewal": self.pending_renewal(targetNode=None, publicKey=None)})
        self.api.on("GET", f"/subscription/{RENEW_HASH}", response({"status": "paid"}))
        self.api.on("POST", "/subscription/status", response({"expiry": "2026-11-01T00:00:00.000Z"}))
        result = self.settle()
        outcome = self.only(result)
        self.assertEqual(outcome["result"], "superseded")
        self.assertIn("earlier version", outcome["message"])
        self.assertNotIn("pendingRenewal", self.read_meta())
        self.assertEqual(result["clearPayTasks"], [])
        self.assertNotIn(("POST", "/subscription/status"), [(m, p) for m, p, _ in self.api.requests])

    def test_unpaid_legacy_renewal_still_waits_and_expires(self):
        self.write_meta({"pendingRenewal": self.pending_renewal(targetNode=None, publicKey=None)})
        self.api.on("GET", f"/subscription/{RENEW_HASH}", response({"status": "pending"}))
        self.assertEqual(self.only(self.settle())["result"], "waiting")
        self.assertEqual(self.only(self.settle(now=NOW + timedelta(hours=25)))["result"], "expired")

    def test_order_and_renewal_settle_in_the_same_tick(self):
        self.write_meta({"pendingRenewal": self.pending_renewal(),
                         "pendingOrder": self.pending_order_for_other_key()})
        self.api.on("GET", f"/subscription/{HASH}", response({"status": "unpaid"}))
        self.api.on("GET", f"/subscription/{RENEW_HASH}", response({"status": "pending"}))
        result = self.settle()
        self.assertEqual([(o["kind"], o["result"]) for o in result["outcomes"]],
                         [("order", "waiting"), ("renewal", "waiting")])

    def pending_order_for_other_key(self):
        priv, pub = bridge.generate_wg_keypair()
        return self.pending_order(privateKey=priv, publicKey=pub)


class TestPayTaskAcknowledgement(SettlementTestBase):
    def test_ack_removes_only_the_given_replay_ids(self):
        self.write_meta({"payTasksToClear": ["tunnelsats-order:lnd", "tunnelsats-renewal:cln"], "vpnPort": 1})
        bridge.ack_pay_tasks(["tunnelsats-order:lnd", "unknown"])
        self.assertEqual(self.read_meta(), {"payTasksToClear": ["tunnelsats-renewal:cln"], "vpnPort": 1})
        bridge.ack_pay_tasks(["tunnelsats-renewal:cln"])
        self.assertEqual(self.read_meta(), {"vpnPort": 1})

    def test_replay_ids_are_unique_per_payment(self):
        # A new Buy on the same node raises its task under its own ID, so
        # clearing a settled payment's task can never remove the new one.
        self.assertEqual(bridge.pay_task_replay_id("order", "lnd", HASH), "tunnelsats-order:lnd:" + HASH[:16])
        self.assertNotEqual(bridge.pay_task_replay_id("order", "lnd", HASH),
                            bridge.pay_task_replay_id("order", "lnd", RENEW_HASH))

    def test_cli_settle_prints_the_outcome_and_ack_clears(self):
        self.write_meta({"payTasksToClear": ["tunnelsats-order:lnd"]})
        out = io.StringIO()
        with patch.object(sys, "argv", ["bridge.py", "settle"]), redirect_stdout(out):
            bridge.main()
        self.assertEqual(json.loads(out.getvalue())["clearPayTasks"], ["tunnelsats-order:lnd"])

        with patch.object(sys, "argv", ["bridge.py", "settle-ack", "tunnelsats-order:lnd"]), \
                redirect_stdout(io.StringIO()):
            bridge.main()
        self.assertNotIn("payTasksToClear", self.read_meta())


class TestSaveConfigurationSettlement(SettlementTestBase):
    CONF = (
        "[Interface]\n"
        "PrivateKey = aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa=\n"
        "Address = 10.9.0.2/32\n"
        "# VPNPort: 24556\n"
        "\n[Peer]\n"
        "PublicKey = bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb=\n"
        "Endpoint = de2.tunnelsats.com:51820\n"
    )

    def test_eclair_is_kept_as_target_node(self):
        bridge.save_configuration(self.CONF, "eclair")
        with open(bridge.APP_CONFIG_PATH) as f:
            self.assertEqual(json.load(f)["target-node"], "eclair")

    def test_clears_the_pending_order_only_for_a_matching_hash(self):
        order = self.pending_order()
        self.write_meta({"pendingOrder": order})
        bridge.save_configuration(self.CONF, "lnd", clear_pending_order="f" * 64)
        self.assertEqual(self.read_meta()["pendingOrder"], order)

        bridge.save_configuration(self.CONF, "lnd", clear_pending_order=HASH)
        meta = self.read_meta()
        self.assertNotIn("pendingOrder", meta)
        self.assertEqual(meta["payTasksToClear"], [ORDER_TASK])

    def test_plain_save_keeps_the_pending_order(self):
        order = self.pending_order()
        self.write_meta({"pendingOrder": order})
        bridge.save_configuration(self.CONF, "lnd")
        self.assertEqual(self.read_meta()["pendingOrder"], order)


if __name__ == "__main__":
    unittest.main()
