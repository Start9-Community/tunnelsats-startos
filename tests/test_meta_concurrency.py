"""Concurrent writers of tunnelsats-meta.json.

The dashboard's sync thread, the forced sync (/api/status?force=1), the
health check (separate process) and save_configuration all read-modify-write
the metadata file; the purchase actions (TypeScript) merge pendingOrder and
pendingRenewal into it. A writer must never replace a newer result with
metadata it loaded before a slow API request, and never drop fields owned by
another writer."""
import fcntl
import json
import os
import subprocess
import sys
import tempfile
import threading
import unittest
import urllib.error
from datetime import datetime, timezone
from unittest.mock import MagicMock, patch

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))
import bridge
from test_expiry_provenance import CONF_WITH_COMMENT, ProvenanceTestBase, api_response

PENDING_ORDER = {
    "paymentHash": "ph", "orderId": "o1", "privateKey": "priv", "publicKey": "pub",
    "targetNode": "lnd", "serverId": "eu-de", "createdAt": "2026-09-26T00:00:00Z",
}
PENDING_RENEWAL = {
    "paymentHash": "ph2", "renewalId": "r1", "oldExpiry": "a", "newExpiry": "b",
    "createdAt": "2026-09-26T00:00:00Z",
}


def not_found():
    return urllib.error.HTTPError("u", 404, "Not Found", {}, None)


class TestConcurrentSyncs(ProvenanceTestBase):
    @patch('bridge.time.sleep')
    @patch('urllib.request.urlopen')
    def test_failure_does_not_erase_a_concurrent_confirmation(self, mock_urlopen, _sleep):
        # The health check confirms the key while the background sync's own
        # request for the same key is still failing.
        def confirmed_elsewhere_then_fail(*_a, **_k):
            self.write_meta({
                "publicKey": "pk_current", "expiresAt": "2026-12-31T23:59:59Z",
                "expirySource": "api", "syncSuccess": True, "syncError": None,
                "lastSync": datetime.now(timezone.utc).isoformat(),
            })
            raise not_found()
        mock_urlopen.side_effect = confirmed_elsewhere_then_fail
        self.assertEqual(bridge.lazy_sync("pk_current"), "failed")
        meta = self.read_meta()
        self.assertTrue(meta["syncSuccess"])
        self.assertEqual(meta["expiresAt"], "2026-12-31T23:59:59Z")
        self.assertIsNone(meta["syncError"])

    @patch('bridge.time.sleep')
    @patch('urllib.request.urlopen')
    def test_failure_after_an_older_confirmation_is_recorded(self, mock_urlopen, _sleep):
        self.write_meta({
            "publicKey": "pk_current", "expiresAt": "2026-12-31T23:59:59Z",
            "expirySource": "api", "syncSuccess": True,
            "lastSync": "2000-01-01T00:00:00+00:00",
        })
        mock_urlopen.side_effect = not_found()
        self.assertEqual(bridge.lazy_sync("pk_current"), "failed")
        meta = self.read_meta()
        self.assertFalse(meta["syncSuccess"])
        self.assertIn("404", meta["syncError"])
        # The last confirmed value for this key is kept, never extended.
        self.assertEqual(meta["expiresAt"], "2026-12-31T23:59:59Z")

    @patch('urllib.request.urlopen')
    def test_success_keeps_fields_written_during_the_request(self, mock_urlopen):
        def order_created_during_request(*_a, **_k):
            self.write_meta({"pendingOrder": PENDING_ORDER})
            return api_response({"expiry": "2026-12-31T23:59:59Z"})
        mock_urlopen.side_effect = order_created_during_request
        self.assertEqual(bridge.lazy_sync("pk_current"), "confirmed")
        meta = self.read_meta()
        self.assertEqual(meta["pendingOrder"], PENDING_ORDER)
        self.assertEqual(meta["expiresAt"], "2026-12-31T23:59:59Z")
        self.assertEqual(meta["publicKey"], "pk_current")

    @patch('bridge.time.sleep')
    @patch('urllib.request.urlopen')
    def test_failure_keeps_fields_written_during_the_request(self, mock_urlopen, _sleep):
        def renewal_created_then_fail(*_a, **_k):
            self.write_meta({"pendingRenewal": PENDING_RENEWAL})
            raise not_found()
        mock_urlopen.side_effect = renewal_created_then_fail
        self.assertEqual(bridge.lazy_sync("pk_current"), "failed")
        meta = self.read_meta()
        self.assertEqual(meta["pendingRenewal"], PENDING_RENEWAL)
        self.assertFalse(meta["syncSuccess"])


class TestSaveConfigurationMerge(ProvenanceTestBase):
    def test_keeps_pending_purchases_and_resets_the_confirmation(self):
        self.write_meta({
            "publicKey": "pk_old", "expiresAt": "2026-12-31T23:59:59Z",
            "expirySource": "api", "syncSuccess": True, "syncError": "x",
            "lastSync": "2026-09-01T00:00:00Z", "lastSyncAttempt": "2026-09-01T00:00:00Z",
            "bandwidth_used_gb": 3.5, "serverDomain": "old.tunnelsats.com",
            "pendingOrder": PENDING_ORDER, "pendingRenewal": PENDING_RENEWAL,
        })
        bridge.save_configuration(CONF_WITH_COMMENT, "lnd")
        meta = self.read_meta()
        # pendingOrder holds the private key of a possibly unclaimed order.
        self.assertEqual(meta["pendingOrder"], PENDING_ORDER)
        self.assertEqual(meta["pendingRenewal"], PENDING_RENEWAL)
        for k in ("publicKey", "expiresAt", "expirySource", "syncError",
                  "lastSyncAttempt", "bandwidth_used_gb", "serverDomain"):
            self.assertNotIn(k, meta)
        self.assertIsNone(meta["lastSync"])
        self.assertFalse(meta["syncSuccess"])
        self.assertEqual(meta["vpnPort"], 24556)


class TestMetaLock(ProvenanceTestBase):
    def test_lock_excludes_other_holders(self):
        held = threading.Event()
        release = threading.Event()

        def holder():
            with bridge.meta_lock():
                held.set()
                release.wait(5)

        t = threading.Thread(target=holder)
        t.start()
        try:
            self.assertTrue(held.wait(5))
            fd = os.open(self.meta_path + ".lock", os.O_RDWR)
            try:
                with self.assertRaises(BlockingIOError):
                    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            finally:
                os.close(fd)
        finally:
            release.set()
            t.join(5)
        fd = os.open(self.meta_path + ".lock", os.O_RDWR)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        finally:
            os.close(fd)
        self.assertEqual(os.stat(self.meta_path + ".lock").st_mode & 0o777, 0o600)


class TestPubkeyCache(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.conf_path = os.path.join(self._tmp.name, "tunnelsatsv3.conf")
        self._orig = bridge.CONFIG_PATH
        bridge.CONFIG_PATH = self.conf_path
        bridge._pubkey_cache = None

    def tearDown(self):
        bridge.CONFIG_PATH = self._orig
        bridge._pubkey_cache = None
        self._tmp.cleanup()

    @staticmethod
    def wg(pub, code=0):
        return MagicMock(returncode=code, stdout=(pub + "\n").encode())

    def test_unchanged_config_is_derived_once(self):
        bridge.atomic_write_file(self.conf_path, CONF_WITH_COMMENT)
        with patch('bridge.subprocess.run', return_value=self.wg("pk_a")) as run:
            self.assertEqual(bridge.get_wg_pubkey(), "pk_a")
            self.assertEqual(bridge.get_wg_pubkey(), "pk_a")
            self.assertEqual(run.call_count, 1)

    def test_saved_config_is_derived_again(self):
        bridge.atomic_write_file(self.conf_path, CONF_WITH_COMMENT)
        with patch('bridge.subprocess.run', side_effect=[self.wg("pk_a"), self.wg("pk_b")]) as run:
            self.assertEqual(bridge.get_wg_pubkey(), "pk_a")
            bridge.atomic_write_file(self.conf_path, CONF_WITH_COMMENT.replace("aaa", "ccc", 1))
            self.assertEqual(bridge.get_wg_pubkey(), "pk_b")
            self.assertEqual(run.call_count, 2)

    def test_failed_derivation_is_not_cached(self):
        bridge.atomic_write_file(self.conf_path, CONF_WITH_COMMENT)
        with patch('bridge.subprocess.run', side_effect=[self.wg("", 1), self.wg("pk_a")]) as run:
            self.assertEqual(bridge.get_wg_pubkey(), "Unknown")
            self.assertEqual(bridge.get_wg_pubkey(), "pk_a")
            self.assertEqual(run.call_count, 2)

    def test_missing_config_is_unknown(self):
        with patch('bridge.subprocess.run') as run:
            self.assertEqual(bridge.get_wg_pubkey(), "Unknown")
            run.assert_not_called()

    def test_wait_loop_does_not_spawn_wg_per_poll_step(self):
        bridge.atomic_write_file(self.conf_path, CONF_WITH_COMMENT)
        with patch('bridge.subprocess.run', return_value=self.wg("pk_a")) as run:
            result = bridge.wait_for_next_sync("failed", "pk_a", sleep=lambda _s: None)
            self.assertEqual(result, "elapsed")
            self.assertEqual(run.call_count, 1)


if __name__ == '__main__':
    unittest.main()
