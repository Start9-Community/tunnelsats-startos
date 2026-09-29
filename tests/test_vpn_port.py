"""Port change (G7): when TunnelSats reports a different forwarded port for
the configured key, the stored configuration's port marker is rewritten, so
the node's clearnet-vpn task is re-raised with the new announce address.

The configuration is otherwise passed on verbatim, so the rewrite touches
the marker digits only, is idempotent (nothing is written when the marker
already holds the port), and never overwrites a configuration another writer
replaced meanwhile (compare-and-swap against the stored file)."""
import io
import json
import os
import sys
import tempfile
import unittest
from contextlib import contextmanager
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
CONF_NEW_PORT = CONF.replace("# VPNPort: 24556", "# VPNPort: 30111")


def api_response(payload):
    resp = MagicMock()
    resp.read.return_value = json.dumps(payload).encode()
    resp.__enter__ = lambda s: s
    resp.__exit__ = MagicMock(return_value=False)
    return resp


def status(**extra):
    payload = {"expiry": "2099-01-01T00:00:00Z", "status": "active",
               "server_domain": "de2.tunnelsats.com", "bandwidth_used_gb": 1.0}
    payload.update(extra)
    return payload


class TestRewriteVpnPort(unittest.TestCase):
    def test_rewrites_only_the_marker_digits(self):
        self.assertEqual(bridge.rewrite_vpn_port(CONF, 30111), CONF_NEW_PORT)

    def test_keeps_the_label_and_spacing_of_every_marker(self):
        conf = "# Port Forwarding:  24556\nx\n#VPNPort:24556\n"
        self.assertEqual(bridge.rewrite_vpn_port(conf, 30111),
                         "# Port Forwarding:  30111\nx\n#VPNPort:30111\n")

    def test_marker_match_is_case_insensitive(self):
        self.assertEqual(bridge.rewrite_vpn_port("# vpnport: 1\n", 2), "# vpnport: 2\n")

    def test_no_change_returns_none(self):
        self.assertIsNone(bridge.rewrite_vpn_port(CONF, 24556))

    def test_no_marker_returns_none(self):
        self.assertIsNone(bridge.rewrite_vpn_port("[Interface]\nAddress = x\n", 30111))

    def test_rejects_invalid_ports(self):
        for bad in (0, 65536, -1, True, "30111", 30111.0, None):
            with self.subTest(bad=bad):
                self.assertIsNone(bridge.valid_vpn_port(bad))
        self.assertEqual(bridge.valid_vpn_port(30111), 30111)


class VpnPortBase(unittest.TestCase):
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
        self.write_conf(CONF)
        self.write_app({"enabled": True, "target-node": "lnd",
                        "allow-ipv6": False, "tunnelsats-conf": CONF})
        self.configured_key = "pk_current"
        self._key_patch = patch('bridge.get_wg_pubkey', side_effect=lambda: self.configured_key)
        self._key_patch.start()
        self._sleep_patch = patch('bridge.time.sleep')
        self._sleep_patch.start()

    def tearDown(self):
        self._sleep_patch.stop()
        self._key_patch.stop()
        bridge.META_FILE_PATH, bridge.CONFIG_PATH, bridge.APP_CONFIG_PATH = self._orig
        self._tmp.cleanup()

    def write_conf(self, text):
        with open(self.conf_path, "w") as f:
            f.write(text)

    def write_app(self, data):
        with open(self.app_path, "w") as f:
            json.dump(data, f)

    def read_conf(self):
        with open(self.conf_path) as f:
            return f.read()

    def read_app(self):
        with open(self.app_path) as f:
            return json.load(f)

    def read_meta(self):
        with open(self.meta_path) as f:
            return json.load(f)


class TestPortChangeOnSync(VpnPortBase):
    @patch('urllib.request.urlopen')
    def test_changed_port_rewrites_both_stored_copies(self, urlopen):
        urlopen.return_value = api_response(status(vpn_port=30111))
        self.assertEqual(bridge.lazy_sync("pk_current"), "confirmed")
        self.assertEqual(self.read_conf(), CONF_NEW_PORT)
        app = self.read_app()
        self.assertEqual(app["tunnelsats-conf"], CONF_NEW_PORT)
        # Other settings are carried over untouched.
        self.assertEqual({k: v for k, v in app.items() if k != "tunnelsats-conf"},
                         {"enabled": True, "target-node": "lnd", "allow-ipv6": False})
        self.assertEqual(self.read_meta()["vpnPort"], 30111)

    @patch('urllib.request.urlopen')
    def test_same_port_writes_nothing(self, urlopen):
        urlopen.return_value = api_response(status(vpn_port=24556))
        with patch('bridge.atomic_write_file') as write_file:
            self.assertEqual(bridge.lazy_sync("pk_current"), "confirmed")
        write_file.assert_not_called()
        self.assertEqual(self.read_app()["tunnelsats-conf"], CONF)

    @patch('urllib.request.urlopen')
    def test_repeated_syncs_are_idempotent(self, urlopen):
        urlopen.return_value = api_response(status(vpn_port=30111))
        bridge.lazy_sync("pk_current")
        app_mtime = os.stat(self.app_path).st_mtime_ns
        conf_ino = os.stat(self.conf_path).st_ino
        urlopen.return_value = api_response(status(vpn_port=30111))
        self.assertEqual(bridge.apply_vpn_port(30111), "unchanged")
        self.assertEqual(os.stat(self.app_path).st_mtime_ns, app_mtime)
        self.assertEqual(os.stat(self.conf_path).st_ino, conf_ino)

    @patch('urllib.request.urlopen')
    def test_missing_port_changes_nothing(self, urlopen):
        urlopen.return_value = api_response(status())
        self.assertEqual(bridge.lazy_sync("pk_current"), "confirmed")
        self.assertEqual(self.read_conf(), CONF)
        self.assertNotIn("vpnPort", self.read_meta())

    @patch('urllib.request.urlopen')
    def test_invalid_port_is_ignored(self, urlopen):
        for bad in ("30111", True, 0, 70000, 30111.5):
            with self.subTest(bad=bad):
                urlopen.return_value = api_response(status(vpn_port=bad))
                self.assertEqual(bridge.lazy_sync("pk_current"), "confirmed")
                self.assertEqual(self.read_conf(), CONF)
                self.assertEqual(self.read_app()["tunnelsats-conf"], CONF)
                self.assertNotIn("vpnPort", self.read_meta())

    @patch('urllib.request.urlopen')
    def test_superseded_sync_rewrites_nothing(self, urlopen):
        def answer(*_a, **_k):
            self.configured_key = "pk_new"
            return api_response(status(vpn_port=30111))
        urlopen.side_effect = answer
        self.assertEqual(bridge.lazy_sync("pk_current"), "superseded")
        self.assertEqual(self.read_conf(), CONF)
        self.assertEqual(self.read_app()["tunnelsats-conf"], CONF)

    @patch('urllib.request.urlopen')
    def test_write_failure_does_not_fail_the_confirmation(self, urlopen):
        urlopen.return_value = api_response(status(vpn_port=30111))
        with patch('bridge._write_json_if_unchanged', side_effect=OSError("disk full")):
            self.assertEqual(bridge.lazy_sync("pk_current"), "confirmed")
        self.assertEqual(self.read_conf(), CONF)
        self.assertIs(self.read_meta()["syncSuccess"], True)


class TestApplyVpnPortCompareAndSwap(VpnPortBase):
    def test_config_replaced_by_another_writer_is_left_alone(self):
        # An import wrote config.json first and has not yet written the conf
        # file: rewriting would bring back the old configuration.
        other = CONF.replace("10.9.0.2", "10.9.0.7")
        self.write_app({"enabled": True, "target-node": "lnd", "tunnelsats-conf": other})
        self.assertEqual(bridge.apply_vpn_port(30111), "conflict")
        self.assertEqual(self.read_app()["tunnelsats-conf"], other)
        self.assertEqual(self.read_conf(), CONF)

    def test_interrupted_rewrite_is_completed(self):
        # config.json was rewritten, the conf file write did not happen.
        self.write_app({"enabled": True, "target-node": "lnd", "tunnelsats-conf": CONF_NEW_PORT})
        self.assertEqual(bridge.apply_vpn_port(30111), "updated")
        self.assertEqual(self.read_conf(), CONF_NEW_PORT)
        self.assertEqual(self.read_app()["tunnelsats-conf"], CONF_NEW_PORT)

    def test_config_json_is_written_before_the_conf_file(self):
        order = []
        real_json, real_file = bridge._write_json_if_unchanged, bridge.atomic_write_file
        with patch('bridge._write_json_if_unchanged',
                   side_effect=lambda p, d, st: (order.append(p), real_json(p, d, st))[1]), \
             patch('bridge.atomic_write_file',
                   side_effect=lambda p, c, mode=0o600: (order.append(p), real_file(p, c, mode))):
            self.assertEqual(bridge.apply_vpn_port(30111), "updated")
        self.assertEqual(order, [self.app_path, self.conf_path])

    def test_config_json_changed_before_the_replace_is_left_alone(self):
        # The TypeScript actions write config.json in place without
        # meta_lock; a write that lands after the read must win.
        with patch('bridge._write_json_if_unchanged', return_value=False):
            self.assertEqual(bridge.apply_vpn_port(30111), "conflict")
        self.assertEqual(self.read_conf(), CONF)

    def test_write_if_unchanged_refuses_a_file_changed_since_its_stamp(self):
        stamp = bridge._file_stamp(self.app_path)
        other = {"enabled": True, "tunnelsats-conf": "changed"}
        with open(self.app_path, "w") as f:
            json.dump(other, f, indent=4)
        self.assertFalse(bridge._write_json_if_unchanged(self.app_path, {"x": 1}, stamp))
        self.assertEqual(self.read_app(), other)
        self.assertFalse(os.path.exists(self.app_path + ".tmp"))
        fresh = bridge._file_stamp(self.app_path)
        self.assertTrue(bridge._write_json_if_unchanged(self.app_path, {"x": 1}, fresh))
        self.assertEqual(self.read_app(), {"x": 1})

    def test_missing_or_unreadable_files_are_left_alone(self):
        os.remove(self.app_path)
        self.assertEqual(bridge.apply_vpn_port(30111), "conflict")
        self.assertEqual(self.read_conf(), CONF)
        os.remove(self.conf_path)
        self.assertEqual(bridge.apply_vpn_port(30111), "no-config")

    def test_config_without_marker_is_left_alone(self):
        bare = CONF.replace("# VPNPort: 24556\n", "")
        self.write_conf(bare)
        self.write_app({"enabled": True, "tunnelsats-conf": bare})
        self.assertEqual(bridge.apply_vpn_port(30111), "no-marker")
        self.assertEqual(self.read_conf(), bare)


class TestSaveConfigurationHoldsTheLock(VpnPortBase):
    def test_configuration_files_are_written_under_meta_lock(self):
        held = {"now": False}
        seen = []
        real_lock = bridge.meta_lock

        @contextmanager
        def tracking_lock():
            with real_lock():
                held["now"] = True
                try:
                    yield
                finally:
                    held["now"] = False
        real_json, real_file = bridge.atomic_write_json, bridge.atomic_write_file

        def rec_json(p, d, mode=0o600):
            seen.append((p, held["now"]))
            return real_json(p, d, mode)

        def rec_file(p, c, mode=0o600):
            seen.append((p, held["now"]))
            return real_file(p, c, mode)
        with patch('bridge.meta_lock', tracking_lock), \
             patch('bridge.atomic_write_json', side_effect=rec_json), \
             patch('bridge.atomic_write_file', side_effect=rec_file):
            bridge.save_configuration(CONF_NEW_PORT, "lnd")
        self.assertEqual({p for p, _ in seen}, {self.conf_path, self.app_path, self.meta_path})
        self.assertTrue(all(h for _, h in seen), seen)


if __name__ == '__main__':
    unittest.main()


class TestPortUpdateRetry(VpnPortBase):
    """A confirmed sync whose port rewrite did not land is retried soon, not
    after the daily wait: the node would announce a stale port meanwhile."""

    def write_meta(self, meta):
        with open(self.meta_path, "w") as f:
            json.dump(meta, f)

    def confirmed(self, **extra):
        meta = {"publicKey": "pk_current", "expirySource": "api",
                "expiresAt": "2099-01-01T00:00:00Z", "syncSuccess": True}
        meta.update(extra)
        return meta

    def test_pending_while_the_marker_differs_from_the_confirmed_port(self):
        self.write_meta(self.confirmed(vpnPort=30111))
        self.assertTrue(bridge.vpn_port_pending("pk_current"))
        self.assertEqual(bridge.sync_wait_outcome("confirmed", "pk_current"), "port-pending")
        self.assertEqual(bridge.next_sync_delay("port-pending"), 300)

    def test_not_pending_once_applied_or_without_a_confirmed_port(self):
        self.write_meta(self.confirmed(vpnPort=24556))
        self.assertFalse(bridge.vpn_port_pending("pk_current"))
        self.write_meta(self.confirmed())
        self.assertFalse(bridge.vpn_port_pending("pk_current"))
        # A port hint for an unconfirmed key or another key never counts.
        self.write_meta({"publicKey": "pk_current", "vpnPort": 30111})
        self.assertFalse(bridge.vpn_port_pending("pk_current"))
        self.write_meta(self.confirmed(vpnPort=30111))
        self.assertFalse(bridge.vpn_port_pending("pk_other"))
        self.assertEqual(bridge.sync_wait_outcome("confirmed", "pk_other"), "confirmed")

    def test_only_a_confirmed_outcome_is_mapped(self):
        self.write_meta(self.confirmed(vpnPort=30111))
        self.assertEqual(bridge.sync_wait_outcome("failed", "pk_current"), "failed")

    @patch('urllib.request.urlopen')
    def test_a_conflicting_rewrite_leaves_the_port_pending(self, urlopen):
        other = CONF.replace("10.9.0.2", "10.9.0.7")
        self.write_app({"enabled": True, "tunnelsats-conf": other})
        urlopen.return_value = api_response(status(vpn_port=30111))
        self.assertEqual(bridge.lazy_sync("pk_current"), "confirmed")
        self.assertEqual(bridge.sync_wait_outcome("confirmed", "pk_current"), "port-pending")
