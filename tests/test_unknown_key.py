"""Unknown key (G6): TunnelSats answering that it has no subscription for the
configured key is a state of its own, not a failed sync. It must be kept
apart from operational failures (network, 5xx, rate limits, other 404s),
and a single answer must not wipe a subscription the API confirmed before:
the status endpoint also answers 404 while one of its servers is
unreachable."""
import io
import json
import os
import sys
import tempfile
import unittest
import urllib.error
from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock, patch

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))
import bridge

CONF = (
    "[Interface]\n"
    "PrivateKey = aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa=\n"
    "Address = 10.9.0.2/32\n"
    "# VPNPort: 24556\n"
    "\n"
    "[Peer]\n"
    "PublicKey = bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb=\n"
    "Endpoint = de2.tunnelsats.com:51820\n"
)

NOT_FOUND_BODY = {"error": "ERR_RESOURCE_NOT_FOUND", "message": "No subscription found for this key"}


def http_error(code, body=None):
    raw = json.dumps(body).encode() if isinstance(body, dict) else (body or b"")
    return urllib.error.HTTPError("https://tunnelsats.com", code, "err", {}, io.BytesIO(raw))


def api_response(payload):
    resp = MagicMock()
    resp.read.return_value = json.dumps(payload).encode()
    resp.__enter__ = lambda s: s
    resp.__exit__ = MagicMock(return_value=False)
    return resp


def iso(dt):
    return dt.astimezone(timezone.utc).isoformat()


class UnknownKeyBase(unittest.TestCase):
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
            f.write(CONF)
        self.configured_key = "pk_current"
        self._key_patch = patch('bridge.get_wg_pubkey', side_effect=lambda: self.configured_key)
        self._key_patch.start()
        self._sleep_patch = patch('bridge.time.sleep')
        self.sleep = self._sleep_patch.start()

    def tearDown(self):
        self._sleep_patch.stop()
        self._key_patch.stop()
        bridge.META_FILE_PATH, bridge.CONFIG_PATH, bridge.APP_CONFIG_PATH = self._orig
        self._tmp.cleanup()

    def write_meta(self, meta):
        with open(self.meta_path, "w") as f:
            json.dump(meta, f)

    def read_meta(self):
        with open(self.meta_path) as f:
            return json.load(f)

    def confirmed_meta(self, **extra):
        meta = {
            "expiresAt": "2099-01-01T00:00:00Z", "expirySource": "api",
            "publicKey": "pk_current", "lastSync": "2026-09-01T00:00:00+00:00",
            "syncSuccess": True, "bandwidth_used_gb": 1.5,
        }
        meta.update(extra)
        return meta


class TestNotFoundAnswer(UnknownKeyBase):
    @patch('urllib.request.urlopen')
    def test_never_confirmed_key_gets_a_short_grace(self, urlopen):
        # A freshly provisioned key can meet the same server-outage 404 as a
        # confirmed one, so even a new key is not written off on one answer.
        urlopen.side_effect = http_error(404, NOT_FOUND_BODY)
        self.assertEqual(bridge.lazy_sync("pk_current"), "not-found")
        meta = self.read_meta()
        self.assertNotIn("keyUnknown", meta)
        self.assertIn("notFoundSince", meta)
        self.assertIn("checking again", meta["syncError"])
        # A definitive answer: no retries against the API within one sync.
        self.assertEqual(urlopen.call_count, 1)

    @patch('urllib.request.urlopen')
    def test_never_confirmed_key_is_declared_unknown_after_the_short_grace(self, urlopen):
        since = iso(datetime.now(timezone.utc) - bridge.NEW_KEY_UNKNOWN_AFTER - timedelta(minutes=1))
        self.write_meta({"publicKey": "pk_current", "syncSuccess": False, "notFoundSince": since})
        urlopen.side_effect = http_error(404, NOT_FOUND_BODY)
        self.assertEqual(bridge.lazy_sync("pk_current"), "unknown-key")
        meta = self.read_meta()
        self.assertIs(meta["keyUnknown"], True)
        self.assertEqual(meta["publicKey"], "pk_current")
        self.assertFalse(meta["syncSuccess"])
        self.assertIn("no subscription", meta["syncError"])
        self.assertNotIn("expiresAt", meta)

    @patch('urllib.request.urlopen')
    def test_a_purchased_key_gets_the_long_grace(self, urlopen):
        # The key of a settled purchase is known to exist: a run of 404s past
        # the short grace is an outage, not a mistyped import.
        since = iso(datetime.now(timezone.utc) - bridge.NEW_KEY_UNKNOWN_AFTER - timedelta(hours=1))
        self.write_meta({"publicKey": "pk_current", "provisionedKey": "pk_current",
                         "syncSuccess": False, "notFoundSince": since})
        urlopen.side_effect = http_error(404, NOT_FOUND_BODY)
        self.assertEqual(bridge.lazy_sync("pk_current"), "not-found")
        self.assertNotIn("keyUnknown", self.read_meta())
        # Only for that key.
        self.write_meta({"publicKey": "pk_current", "provisionedKey": "pk_other",
                         "syncSuccess": False, "notFoundSince": since})
        urlopen.side_effect = http_error(404, NOT_FOUND_BODY)
        self.assertEqual(bridge.lazy_sync("pk_current"), "unknown-key")

    def test_a_settled_purchase_records_its_key_and_an_import_drops_it(self):
        bridge.save_configuration(CONF, "lnd", clear_pending_order="f" * 64,
                                  provisioned_key="pk_current")
        self.assertEqual(self.read_meta()["provisionedKey"], "pk_current")
        bridge.save_configuration(CONF, "lnd")
        self.assertNotIn("provisionedKey", self.read_meta())

    def test_the_short_grace_is_shorter_than_the_confirmed_one(self):
        self.assertLess(bridge.NEW_KEY_UNKNOWN_AFTER, bridge.UNKNOWN_KEY_CONFIRM_AFTER)
        # The retry after a not-found answer lands after the short grace, so
        # a new unknown key is reported on its second answer.
        self.assertGreaterEqual(timedelta(seconds=bridge.next_sync_delay("not-found")),
                                bridge.NEW_KEY_UNKNOWN_AFTER)

    @patch('urllib.request.urlopen')
    def test_confirmed_key_keeps_its_expiry_on_a_first_not_found(self, urlopen):
        # The endpoint also answers 404 while one of its servers is down, so
        # a key it confirmed before is not written off on one answer.
        self.write_meta(self.confirmed_meta())
        urlopen.side_effect = http_error(404, NOT_FOUND_BODY)
        self.assertEqual(bridge.lazy_sync("pk_current"), "not-found")
        meta = self.read_meta()
        self.assertNotIn("keyUnknown", meta)
        self.assertEqual(meta["expiresAt"], "2099-01-01T00:00:00Z")
        self.assertEqual(meta["expirySource"], "api")
        self.assertFalse(meta["syncSuccess"])
        self.assertIn("checking again", meta["syncError"])
        self.assertIn("notFoundSince", meta)

    @patch('urllib.request.urlopen')
    def test_streak_start_survives_later_answers(self, urlopen):
        since = iso(datetime.now(timezone.utc) - timedelta(hours=2))
        self.write_meta(self.confirmed_meta(syncSuccess=False, notFoundSince=since))
        urlopen.side_effect = http_error(404, NOT_FOUND_BODY)
        self.assertEqual(bridge.lazy_sync("pk_current"), "not-found")
        self.assertEqual(
            bridge._parse_iso(self.read_meta()["notFoundSince"]), bridge._parse_iso(since))

    @patch('urllib.request.urlopen')
    def test_confirmed_key_is_declared_unknown_after_a_day_of_not_found(self, urlopen):
        since = iso(datetime.now(timezone.utc) - bridge.UNKNOWN_KEY_CONFIRM_AFTER - timedelta(minutes=1))
        self.write_meta(self.confirmed_meta(syncSuccess=False, notFoundSince=since))
        urlopen.side_effect = http_error(404, NOT_FOUND_BODY)
        self.assertEqual(bridge.lazy_sync("pk_current"), "unknown-key")
        meta = self.read_meta()
        self.assertIs(meta["keyUnknown"], True)
        for field in ("expiresAt", "expirySource", "lastSync", "bandwidth_used_gb"):
            self.assertNotIn(field, meta)

    @patch('urllib.request.urlopen')
    def test_declared_unknown_stays_unknown_on_the_next_not_found(self, urlopen):
        self.write_meta({"publicKey": "pk_current", "keyUnknown": True, "syncSuccess": False,
                         "notFoundSince": iso(datetime.now(timezone.utc))})
        urlopen.side_effect = http_error(404, NOT_FOUND_BODY)
        self.assertEqual(bridge.lazy_sync("pk_current"), "unknown-key")
        self.assertIs(self.read_meta()["keyUnknown"], True)


class TestOperationalFailuresAreNotUnknownKey(UnknownKeyBase):
    def assert_plain_failure(self, meta):
        self.assertNotIn("keyUnknown", meta)
        self.assertNotIn("notFoundSince", meta)
        self.assertFalse(meta["syncSuccess"])
        self.assertTrue(meta["syncError"])

    @patch('urllib.request.urlopen')
    def test_404_without_the_not_found_code_is_a_failure(self, urlopen):
        # A 404 from a proxy, a CDN or a removed route says nothing about the key.
        urlopen.side_effect = http_error(404, b"<html>Not Found</html>")
        self.assertEqual(bridge.lazy_sync("pk_current"), "failed")
        self.assert_plain_failure(self.read_meta())

    @patch('urllib.request.urlopen')
    def test_404_with_another_error_code_is_a_failure(self, urlopen):
        urlopen.side_effect = http_error(404, {"error": "ERR_MIGRATION_REQUIRED", "message": "x"})
        self.assertEqual(bridge.lazy_sync("pk_current"), "failed")
        self.assert_plain_failure(self.read_meta())

    @patch('urllib.request.urlopen')
    def test_server_errors_and_rate_limits_are_failures(self, urlopen):
        for code in (429, 500, 503):
            urlopen.side_effect = http_error(code, {"error": "ERR_INTERNAL_ERROR", "message": "x"})
            self.assertEqual(bridge.lazy_sync("pk_current"), "failed", code)
            self.assert_plain_failure(self.read_meta())

    @patch('urllib.request.urlopen')
    def test_operational_failure_restarts_the_not_found_streak(self, urlopen):
        # "Not found" must be answered continuously for the grace period: a
        # 404, a day of unrelated failures and another 404 is no streak.
        since = iso(datetime.now(timezone.utc) - bridge.UNKNOWN_KEY_CONFIRM_AFTER + timedelta(minutes=5))
        self.write_meta(self.confirmed_meta(syncSuccess=False, notFoundSince=since))
        urlopen.side_effect = urllib.error.URLError("unreachable")
        self.assertEqual(bridge.lazy_sync("pk_current"), "failed")
        self.assertNotIn("notFoundSince", self.read_meta())
        urlopen.side_effect = http_error(404, NOT_FOUND_BODY)
        self.assertEqual(bridge.lazy_sync("pk_current"), "not-found")
        meta = self.read_meta()
        self.assertNotIn("keyUnknown", meta)
        self.assertEqual(meta["expiresAt"], "2099-01-01T00:00:00Z")
        self.assertLess(datetime.now(timezone.utc) - bridge._parse_iso(meta["notFoundSince"]),
                        timedelta(minutes=1))

    @patch('urllib.request.urlopen', side_effect=urllib.error.URLError("unreachable"))
    def test_transient_failure_keeps_a_declared_unknown_key(self, _urlopen):
        self.write_meta({"publicKey": "pk_current", "keyUnknown": True, "syncSuccess": False,
                         "notFoundSince": "2026-09-01T00:00:00+00:00"})
        self.assertEqual(bridge.lazy_sync("pk_current"), "failed")
        meta = self.read_meta()
        self.assertIs(meta["keyUnknown"], True)
        self.assertEqual(meta["notFoundSince"], "2026-09-01T00:00:00+00:00")
        self.assertIn("unreachable", meta["syncError"])


class TestUnknownKeyLifecycle(UnknownKeyBase):
    @patch('urllib.request.urlopen')
    def test_confirmation_clears_the_unknown_key_state(self, urlopen):
        self.write_meta({"publicKey": "pk_current", "keyUnknown": True, "syncSuccess": False,
                         "notFoundSince": "2026-09-01T00:00:00+00:00", "syncError": "x"})
        urlopen.return_value = api_response({"expiry": "2099-01-01T00:00:00Z"})
        self.assertEqual(bridge.lazy_sync("pk_current"), "confirmed")
        meta = self.read_meta()
        self.assertNotIn("keyUnknown", meta)
        self.assertNotIn("notFoundSince", meta)
        self.assertTrue(meta["syncSuccess"])

    @patch('urllib.request.urlopen', side_effect=urllib.error.URLError("down"))
    def test_a_new_key_does_not_inherit_the_unknown_key_state(self, _urlopen):
        self.configured_key = "pk_new"
        self.write_meta({"publicKey": "pk_old", "keyUnknown": True,
                         "notFoundSince": "2026-09-01T00:00:00+00:00"})
        bridge.lazy_sync("pk_new")
        meta = self.read_meta()
        self.assertEqual(meta["publicKey"], "pk_new")
        self.assertNotIn("keyUnknown", meta)
        self.assertNotIn("notFoundSince", meta)

    def test_saving_a_configuration_drops_the_unknown_key_state(self):
        self.write_meta({"publicKey": "pk_current", "keyUnknown": True,
                         "notFoundSince": "2026-09-01T00:00:00+00:00"})
        bridge.save_configuration(CONF, "lnd")
        meta = self.read_meta()
        self.assertNotIn("keyUnknown", meta)
        self.assertNotIn("notFoundSince", meta)

    @patch('urllib.request.urlopen')
    def test_not_found_for_a_replaced_key_is_discarded(self, urlopen):
        def save_then_not_found(*_a, **_k):
            self.configured_key = "pk_new"
            self.write_meta({"publicKey": "pk_new", "syncSuccess": False})
            raise http_error(404, NOT_FOUND_BODY)
        urlopen.side_effect = save_then_not_found
        self.assertEqual(bridge.lazy_sync("pk_current"), "superseded")
        self.assertNotIn("keyUnknown", self.read_meta())

    @patch('urllib.request.urlopen')
    def test_not_found_does_not_override_a_newer_concurrent_confirmation(self, urlopen):
        def confirmed_meanwhile(*_a, **_k):
            future = iso(datetime.now(timezone.utc) + timedelta(seconds=5))
            self.write_meta({"publicKey": "pk_current", "expiresAt": "2099-01-01T00:00:00Z",
                             "expirySource": "api", "syncSuccess": True, "lastSync": future})
            raise http_error(404, NOT_FOUND_BODY)
        urlopen.side_effect = confirmed_meanwhile
        self.assertEqual(bridge.lazy_sync("pk_current"), "not-found")
        meta = self.read_meta()
        self.assertTrue(meta["syncSuccess"])
        self.assertNotIn("keyUnknown", meta)

    def test_retry_delays_after_not_found_and_unknown_key(self):
        self.assertEqual(bridge.next_sync_delay("unknown-key"), 3600)
        self.assertEqual(bridge.next_sync_delay("not-found"), 900)


class TestUnknownKeyReporting(UnknownKeyBase):
    def test_subscription_info_reports_an_unknown_key_for_the_same_key_only(self):
        self.write_meta({"publicKey": "pk_current", "keyUnknown": True, "syncSuccess": False,
                         "syncError": bridge.UNKNOWN_KEY_MESSAGE})
        info = bridge.get_subscription_info("pk_current")
        self.assertIs(info["keyUnknown"], True)
        self.assertFalse(info["linked"])
        self.assertIs(bridge.get_subscription_info("pk_other")["keyUnknown"], False)

    @patch('bridge.is_enabled', return_value=True)
    def test_dashboard_status_names_the_unknown_key(self, _enabled):
        self.write_meta({"publicKey": "pk_current", "keyUnknown": True, "syncSuccess": False,
                         "syncError": bridge.UNKNOWN_KEY_MESSAGE})
        status = bridge.get_status()
        self.assertEqual(status["status"], "unknown_key")
        self.assertIs(status["key_unknown"], True)
        self.assertEqual(status["sync_error"], bridge.UNKNOWN_KEY_MESSAGE)

    @patch('bridge.is_enabled', return_value=True)
    @patch('bridge.lazy_sync')
    @patch('sys.stdout', new_callable=io.StringIO)
    def test_health_names_the_unknown_key(self, stdout, lazy_sync, _enabled):
        self.write_meta({"publicKey": "pk_current", "keyUnknown": True, "syncSuccess": False,
                         "syncError": bridge.UNKNOWN_KEY_MESSAGE})
        with patch('sys.argv', ['bridge.py', 'health', 'subscription']):
            with self.assertRaises(SystemExit) as cm:
                bridge.main()
        out = json.loads(stdout.getvalue())
        self.assertEqual(out["result"], "failure")
        self.assertEqual(out["message"], bridge.UNKNOWN_KEY_MESSAGE)
        self.assertEqual(cm.exception.code, 1)
        lazy_sync.assert_not_called()


if __name__ == '__main__':
    unittest.main()
