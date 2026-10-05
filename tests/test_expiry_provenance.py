"""Expiry provenance: only the TunnelSats API's answer for the current key
counts as a confirmed expiry. The `# Valid Until` comment is a hint and must
never be written into, or read back as, the confirmed expiry (Issue #3)."""
import io
import json
import os
import sys
import tempfile
import unittest
import urllib.error
from unittest.mock import MagicMock, patch

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))
import bridge

CONF_WITH_COMMENT = (
    "[Interface]\n"
    "PrivateKey = aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa=\n"
    "Address = 10.9.0.2/32\n"
    "# VPNPort: 24556\n"
    "# Valid Until: 2099-12-31T23:59:59Z\n"
    "\n"
    "[Peer]\n"
    "PublicKey = bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb=\n"
    "Endpoint = de2.tunnelsats.com:51820\n"
)


def api_response(payload):
    resp = MagicMock()
    resp.read.return_value = json.dumps(payload).encode()
    resp.__enter__ = lambda s: s
    resp.__exit__ = MagicMock(return_value=False)
    return resp


class ProvenanceTestBase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        d = self._tmp.name
        self.meta_path = os.path.join(d, "tunnelsats-meta.json")
        self.conf_path = os.path.join(d, "tunnelsatsv3.conf")
        self.app_path = os.path.join(d, "config.json")
        self._orig = (bridge.META_FILE_PATH, bridge.CONFIG_PATH, bridge.APP_CONFIG_PATH)
        bridge.META_FILE_PATH = self.meta_path
        bridge.CONFIG_PATH = self.conf_path
        bridge.APP_CONFIG_PATH = self.app_path
        with open(self.conf_path, "w") as f:
            f.write(CONF_WITH_COMMENT)
        # The key the saved configuration currently holds (lazy_sync re-checks
        # it before committing a result).
        self.configured_key = "pk_current"
        self._key_patch = patch('bridge.get_wg_pubkey', side_effect=lambda: self.configured_key)
        self._key_patch.start()

    def tearDown(self):
        self._key_patch.stop()
        bridge.META_FILE_PATH, bridge.CONFIG_PATH, bridge.APP_CONFIG_PATH = self._orig
        self._tmp.cleanup()

    def write_meta(self, meta):
        with open(self.meta_path, "w") as f:
            json.dump(meta, f)

    def read_meta(self):
        with open(self.meta_path) as f:
            return json.load(f)


class TestLazySyncProvenance(ProvenanceTestBase):
    @patch('urllib.request.urlopen')
    def test_success_records_api_provenance_and_key(self, mock_urlopen):
        mock_urlopen.return_value = api_response(
            {"expiry": "2026-12-31T23:59:59Z", "server_domain": "de2.tunnelsats.com", "vpn_port": 24556}
        )
        bridge.lazy_sync("pk_current")
        meta = self.read_meta()
        self.assertEqual(meta["expiresAt"], "2026-12-31T23:59:59Z")
        self.assertEqual(meta["expirySource"], "api")
        self.assertEqual(meta["publicKey"], "pk_current")
        self.assertTrue(meta["syncSuccess"])

    @patch('bridge.time.sleep')
    @patch('urllib.request.urlopen', side_effect=urllib.error.URLError("unreachable"))
    def test_failure_never_seeds_expiry_from_comment(self, _urlopen, _sleep):
        bridge.lazy_sync("pk_current")
        meta = self.read_meta()
        self.assertNotIn("expiresAt", meta)
        self.assertNotIn("expirySource", meta)
        self.assertFalse(meta["syncSuccess"])
        self.assertIn("unreachable", meta["syncError"])

    @patch('bridge.time.sleep')
    @patch('urllib.request.urlopen', side_effect=urllib.error.URLError("unreachable"))
    def test_failure_keeps_last_confirmed_value_for_the_same_key(self, _urlopen, _sleep):
        self.write_meta({
            "expiresAt": "2026-10-01T00:00:00Z", "expirySource": "api",
            "publicKey": "pk_current", "lastSync": "2026-09-01T00:00:00Z", "syncSuccess": True,
        })
        bridge.lazy_sync("pk_current")
        meta = self.read_meta()
        self.assertEqual(meta["expiresAt"], "2026-10-01T00:00:00Z")
        self.assertEqual(meta["expirySource"], "api")
        self.assertEqual(meta["lastSync"], "2026-09-01T00:00:00Z")
        self.assertFalse(meta["syncSuccess"])

    @patch('bridge.time.sleep')
    @patch('urllib.request.urlopen', side_effect=urllib.error.URLError("unreachable"))
    def test_key_change_drops_previous_confirmation(self, _urlopen, _sleep):
        self.configured_key = "pk_new"
        self.write_meta({
            "expiresAt": "2026-10-01T00:00:00Z", "expirySource": "api",
            "publicKey": "pk_old", "lastSync": "2026-09-01T00:00:00Z",
            "syncSuccess": True, "bandwidth_used_gb": 12.5,
        })
        bridge.lazy_sync("pk_new")
        meta = self.read_meta()
        self.assertEqual(meta["publicKey"], "pk_new")
        for k in ("expiresAt", "expirySource", "lastSync", "bandwidth_used_gb"):
            self.assertNotIn(k, meta)
        self.assertFalse(meta["syncSuccess"])

    @patch('urllib.request.urlopen')
    def test_answer_without_valid_expiry_is_a_sync_error(self, mock_urlopen):
        mock_urlopen.return_value = api_response({"server_domain": "de2.tunnelsats.com"})
        bridge.lazy_sync("pk_current")
        meta = self.read_meta()
        self.assertNotIn("expiresAt", meta)
        self.assertFalse(meta["syncSuccess"])
        self.assertTrue(meta["syncError"])


class TestSupersededSync(ProvenanceTestBase):
    @patch('urllib.request.urlopen')
    def test_result_for_a_replaced_key_is_discarded(self, mock_urlopen):
        # A new configuration is saved while the sync for the old key is in
        # flight: its confirmation must not overwrite the save's reset.
        def save_during_request(*_a, **_k):
            self.configured_key = "pk_new"
            self.write_meta({"publicKey": "pk_new", "syncSuccess": False, "lastSync": None})
            return api_response({"expiry": "2026-12-31T23:59:59Z"})
        mock_urlopen.side_effect = save_during_request
        self.assertEqual(bridge.lazy_sync("pk_current"), "superseded")
        meta = self.read_meta()
        self.assertEqual(meta["publicKey"], "pk_new")
        self.assertNotIn("expiresAt", meta)
        self.assertFalse(meta["syncSuccess"])

    @patch('bridge.time.sleep')
    @patch('urllib.request.urlopen')
    def test_failure_for_a_replaced_key_is_discarded(self, mock_urlopen, _sleep):
        def save_then_fail(*_a, **_k):
            self.configured_key = "pk_new"
            self.write_meta({"publicKey": "pk_new", "syncSuccess": False})
            raise urllib.error.HTTPError("u", 404, "Not Found", {}, None)
        mock_urlopen.side_effect = save_then_fail
        self.assertEqual(bridge.lazy_sync("pk_current"), "superseded")
        self.assertNotIn("syncError", self.read_meta())

    @patch('bridge.time.sleep')
    @patch('urllib.request.urlopen')
    def test_outcomes_are_explicit(self, mock_urlopen, _sleep):
        mock_urlopen.return_value = api_response({"expiry": "2026-12-31T23:59:59Z"})
        self.assertEqual(bridge.lazy_sync("pk_current"), "confirmed")
        mock_urlopen.side_effect = urllib.error.URLError("down")
        self.assertEqual(bridge.lazy_sync("pk_current"), "failed")
        self.assertEqual(bridge.lazy_sync("Unknown"), "skipped")


class TestSyncLoopWait(unittest.TestCase):
    def test_long_wait_only_after_confirmation(self):
        self.assertEqual(bridge.next_sync_delay("confirmed"), 86400)
        self.assertEqual(bridge.next_sync_delay("failed"), 300)
        self.assertEqual(bridge.next_sync_delay("skipped"), 300)
        self.assertLess(bridge.next_sync_delay("superseded"), 60)

    def test_wait_ends_early_when_the_configured_key_changes(self):
        slept = []
        keys = iter(["pk_a", "pk_a", "pk_b"])
        result = bridge.wait_for_next_sync(
            "confirmed", "pk_a", sleep=slept.append, current_key=lambda: next(keys)
        )
        self.assertEqual(result, "key-changed")
        self.assertEqual(slept, [bridge.SYNC_POLL_STEP] * 3)

    def test_wait_runs_to_the_deadline_while_the_key_is_unchanged(self):
        slept = []
        result = bridge.wait_for_next_sync(
            "failed", "pk_a", sleep=slept.append, current_key=lambda: "pk_a"
        )
        self.assertEqual(result, "elapsed")
        self.assertEqual(sum(slept), bridge.next_sync_delay("failed"))


class TestSaveConfigurationProvenance(ProvenanceTestBase):
    def test_does_not_seed_expiry_from_comment(self):
        bridge.save_configuration(CONF_WITH_COMMENT, "lnd")
        meta = self.read_meta()
        self.assertNotIn("expiresAt", meta)
        self.assertNotIn("expirySource", meta)
        self.assertFalse(meta["syncSuccess"])


class TestSubscriptionInfoProvenance(ProvenanceTestBase):
    def test_legacy_unconfirmed_expiry_is_ignored(self):
        self.write_meta({"expiresAt": "2099-01-01T00:00:00Z", "syncSuccess": True,
                         "lastSync": "2026-09-01T00:00:00Z"})
        info = bridge.get_subscription_info("pk_current")
        self.assertIsNone(info["expiresAt"])
        self.assertFalse(info["linked"])

    def test_expiry_confirmed_for_another_key_is_ignored(self):
        self.write_meta({"expiresAt": "2099-01-01T00:00:00Z", "expirySource": "api",
                         "publicKey": "pk_old", "syncSuccess": True,
                         "lastSync": "2026-09-01T00:00:00Z"})
        info = bridge.get_subscription_info("pk_new")
        self.assertIsNone(info["expiresAt"])
        self.assertFalse(info["linked"])

    def test_expiry_confirmed_for_current_key_is_used(self):
        self.write_meta({"expiresAt": "2099-01-01T00:00:00Z", "expirySource": "api",
                         "publicKey": "pk_current", "syncSuccess": True,
                         "lastSync": "2026-09-01T00:00:00Z"})
        info = bridge.get_subscription_info("pk_current")
        self.assertEqual(info["expiresAt"], "2099-01-01T00:00:00Z")
        self.assertTrue(info["linked"])
        self.assertFalse(info["isExpired"])

    def test_sync_error_of_another_key_is_ignored(self):
        self.write_meta({"publicKey": "pk_old", "syncSuccess": False,
                         "syncError": "HTTP Error 404: Not Found"})
        info = bridge.get_subscription_info("pk_new")
        self.assertIsNone(info["syncError"])
        self.assertFalse(info["syncSuccess"])
        self.assertFalse(info["linked"])

    def test_sync_error_of_the_current_key_is_reported(self):
        self.write_meta({"publicKey": "pk_current", "syncSuccess": False,
                         "syncError": "unreachable"})
        info = bridge.get_subscription_info("pk_current")
        self.assertEqual(info["syncError"], "unreachable")


class TestHealthProvenance(ProvenanceTestBase):
    @patch('bridge.is_enabled', return_value=True)
    @patch('bridge.get_wg_pubkey', return_value="pk_new")
    @patch('bridge.lazy_sync')
    @patch('sys.stdout', new_callable=io.StringIO)
    def test_health_resyncs_when_confirmation_belongs_to_another_key(
        self, mock_stdout, mock_lazy_sync, _pubkey, _enabled
    ):
        self.write_meta({"expiresAt": "2099-01-01T00:00:00Z", "expirySource": "api",
                         "publicKey": "pk_old", "syncSuccess": True,
                         "lastSync": "2026-09-01T00:00:00Z"})
        with patch('sys.argv', ['bridge.py', 'health', 'subscription']):
            with self.assertRaises(SystemExit) as cm:
                bridge.main()
        mock_lazy_sync.assert_called_once_with("pk_new")
        out = json.loads(mock_stdout.getvalue())
        # Still unconfirmed after the (mocked, no-op) sync: never "ok".
        self.assertEqual(out["result"], "loading")
        self.assertEqual(cm.exception.code, 0)

    @patch('bridge.is_enabled', return_value=True)
    @patch('bridge.get_wg_pubkey', return_value="pk_new")
    @patch('bridge.lazy_sync')
    @patch('sys.stdout', new_callable=io.StringIO)
    def test_health_resyncs_when_sync_error_belongs_to_another_key(
        self, mock_stdout, mock_lazy_sync, _pubkey, _enabled
    ):
        # A freshly imported key must not inherit the previous key's failure.
        self.write_meta({"publicKey": "pk_old", "syncSuccess": False,
                         "syncError": "HTTP Error 404: Not Found"})
        with patch('sys.argv', ['bridge.py', 'health', 'subscription']):
            with self.assertRaises(SystemExit) as cm:
                bridge.main()
        mock_lazy_sync.assert_called_once_with("pk_new")
        out = json.loads(mock_stdout.getvalue())
        self.assertEqual(out["result"], "loading")
        self.assertEqual(cm.exception.code, 0)


if __name__ == '__main__':
    unittest.main()
