import unittest
import json
import os
import sys
import tempfile
from unittest.mock import MagicMock, patch

# Add the parent directory to sys.path
REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
sys.path.insert(0, REPO_ROOT)
sys.path.insert(0, os.path.abspath(os.path.dirname(__file__)))

import bridge
from test_nwc import _LoopbackNip47Server

class TestBridgeConfig(unittest.TestCase):
    def test_extract_vpn_port_found(self):
        config_content = """
[Interface]
PrivateKey = key
# VPNPort: 12345
Address = 10.0.0.1/32
"""
        port = bridge.extract_vpn_port(config_content)
        self.assertEqual(port, 12345)

    def test_extract_vpn_port_missing_defaults(self):
        config_content = """
[Interface]
PrivateKey = key
Address = 10.0.0.1/32
"""
        port = bridge.extract_vpn_port(config_content)
        self.assertEqual(port, 9735) # Default as per implementation plan

    def test_extract_vpn_port_invalid_defaults(self):
        config_content = """
# VPNPort: abc
"""
        port = bridge.extract_vpn_port(config_content)
        self.assertEqual(port, 9735)

if __name__ == '__main__':
    unittest.main()

def _version_json_semver():
    """The version bridge.py reports: version.json as the image ships it."""
    with open(os.path.join(REPO_ROOT, "version.json")) as f:
        return json.load(f)["semver"]


def _response(payload):
    """An urlopen() answer: only the transport is replaced, the request is real."""
    resp = MagicMock()
    resp.status = 200
    resp.read.return_value = json.dumps(payload).encode()
    resp.__enter__ = lambda s: s
    resp.__exit__ = MagicMock(return_value=False)
    return resp


class TestPackageVersion(unittest.TestCase):
    def setUp(self):
        env = patch.dict(os.environ)
        env.start()
        self.addCleanup(env.stop)
        os.environ.pop("PACKAGE_VERSION", None)
        bridge._package_version_cache = None
        self.addCleanup(setattr, bridge, "_package_version_cache", None)

    def test_get_package_version_from_version_json(self):
        self.assertEqual(bridge.get_package_version(), _version_json_semver())

    def test_get_package_version_from_env(self):
        os.environ["PACKAGE_VERSION"] = "1.2.3:4"
        self.assertEqual(bridge.get_package_version(), "1.2.3")

    def test_version_is_unknown_without_env_or_version_json(self):
        with tempfile.TemporaryDirectory() as d:
            with patch.object(bridge, "VERSION_JSON_PATH", os.path.join(d, "version.json")):
                self.assertIsNone(bridge.get_package_version())
                self.assertEqual(bridge.user_agent(), "TunnelSats-StartOS/unknown")

    def test_a_malformed_version_is_never_sent(self):
        os.environ["PACKAGE_VERSION"] = "1.0.0\r\nX-Injected: yes"
        self.assertEqual(bridge.get_package_version(), _version_json_semver())
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "version.json")
            with open(path, "w") as f:
                json.dump({"version": "1.0.0:0", "semver": "1.0.0 (x)"}, f)
            bridge._package_version_cache = None
            with patch.object(bridge, "VERSION_JSON_PATH", path):
                self.assertEqual(bridge.user_agent(), "TunnelSats-StartOS/unknown")

    @patch("urllib.request.urlopen")
    def test_api_requests_send_the_package_version_as_user_agent(self, urlopen):
        urlopen.return_value = _response({"servers": [{"id": "eu-de", "country": "Germany", "status": "online"}]})
        bridge._fetch_servers()
        bridge._api_call("GET", "/subscription/" + "ab" * 32)
        expected = f"TunnelSats-StartOS/{_version_json_semver()}"
        sent = [c.args[0].get_header("User-agent") for c in urlopen.call_args_list]
        self.assertEqual(sent, [expected, expected])

    def test_nwc_relay_handshake_sends_the_package_version_as_user_agent(self):
        server = _LoopbackNip47Server("11" * 32, lambda method, params: {"result_type": method, "result": {}})
        self.addCleanup(server.close)
        parsed = bridge.parse_nwc_uri(
            f"nostr+walletconnect://{server.wallet_pubkey_hex}"
            f"?relay=ws://testwallet.onion:8080/ws&secret={'22' * 32}"
        )
        with patch.object(bridge, "TOR_SOCKS_HOST", "127.0.0.1"), patch.object(bridge, "TOR_SOCKS_PORT", server.port):
            bridge.nwc_execute_command(parsed, "get_budget", {}, route_via_tor=True, timeout=5)
        self.assertEqual(server.user_agents, [f"TunnelSats-StartOS/{_version_json_semver()}"])

class TestBridgeKeygenAndConfig(unittest.TestCase):
    def test_derive_wg_pubkey(self):
        import base64
        priv = base64.b64encode(os.urandom(32)).decode()
        pub = bridge.derive_wg_pubkey(priv)
        self.assertTrue(isinstance(pub, str) and len(pub) == 44)
        self.assertTrue(pub.endswith("="))
        self.assertIsNone(bridge.derive_wg_pubkey("not-a-valid-key"))

    def test_save_configuration_valid(self):
        import tempfile
        with tempfile.TemporaryDirectory() as tmpdir:
            conf_file = os.path.join(tmpdir, "tunnelsatsv3.conf")
            app_conf_file = os.path.join(tmpdir, "config.json")
            meta_file = os.path.join(tmpdir, "tunnelsats-meta.json")

            orig_conf = bridge.CONFIG_PATH
            orig_app = bridge.APP_CONFIG_PATH
            orig_meta = bridge.META_FILE_PATH
            try:
                bridge.CONFIG_PATH = conf_file
                bridge.APP_CONFIG_PATH = app_conf_file
                bridge.META_FILE_PATH = meta_file

                sample_conf = (
                    "[Interface]\n"
                    "PrivateKey = aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa=\n"
                    "Address = 10.9.0.2/32\n"
                    "# VPNPort: 24556\n"
                    "# Valid Until: 2026-12-31T23:59:59Z\n"
                    "# Server: ch1.tunnelsats.com\n"
                    "\n"
                    "[Peer]\n"
                    "PublicKey = bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb=\n"
                    "Endpoint = de2.tunnelsats.com:51820\n"
                )

                bridge.save_configuration(sample_conf, "cln")

                self.assertTrue(os.path.exists(conf_file))
                with open(conf_file, "r") as f:
                    saved_conf = f.read()
                    self.assertEqual(saved_conf, sample_conf)
                    self.assertNotIn("# StartTunnel", saved_conf)
                    self.assertNotIn("# inbound: yes", saved_conf)

                self.assertTrue(os.path.exists(app_conf_file))
                with open(app_conf_file, "r") as f:
                    import json
                    app_data = json.load(f)
                    self.assertTrue(app_data.get("enabled"))
                    self.assertEqual(app_data.get("target-node"), "cln")
                    self.assertEqual(app_data.get("tunnelsats-conf"), sample_conf)

                self.assertTrue(os.path.exists(meta_file))
                with open(meta_file, "r") as f:
                    meta_data = json.load(f)
                    self.assertEqual(meta_data.get("vpnPort"), 24556)
                    # The # Valid Until comment is never trusted as an expiry;
                    # only the API sync may write expiresAt.
                    self.assertNotIn("expiresAt", meta_data)
                    self.assertEqual(meta_data.get("serverDomain"), "ch1.tunnelsats.com")

                # Verify files have 0600 owner-only permissions
                self.assertEqual(os.stat(conf_file).st_mode & 0o777, 0o600)
                self.assertEqual(os.stat(app_conf_file).st_mode & 0o777, 0o600)
                self.assertEqual(os.stat(meta_file).st_mode & 0o777, 0o600)
            finally:
                bridge.CONFIG_PATH = orig_conf
                bridge.APP_CONFIG_PATH = orig_app
                bridge.META_FILE_PATH = orig_meta

    def test_save_configuration_invalid(self):
        with self.assertRaises(ValueError):
            bridge.save_configuration("invalid content without private key", "lnd")

    def test_save_configuration_unsupported_node_defaults_to_lnd(self):
        import tempfile
        with tempfile.TemporaryDirectory() as tmpdir:
            conf_file = os.path.join(tmpdir, "tunnelsatsv3.conf")
            app_conf_file = os.path.join(tmpdir, "config.json")
            meta_file = os.path.join(tmpdir, "tunnelsats-meta.json")

            orig_conf = bridge.CONFIG_PATH
            orig_app = bridge.APP_CONFIG_PATH
            orig_meta = bridge.META_FILE_PATH
            try:
                bridge.CONFIG_PATH = conf_file
                bridge.APP_CONFIG_PATH = app_conf_file
                bridge.META_FILE_PATH = meta_file

                sample_conf = (
                    "[Interface]\n"
                    "PrivateKey = aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa=\n"
                    "Address = 10.9.0.2/32\n"
                    "# VPNPort: 24556\n"
                    "# Valid Until: 2026-12-31T23:59:59Z\n"
                    "\n"
                    "[Peer]\n"
                    "PublicKey = bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb=\n"
                    "Endpoint = de2.tunnelsats.com:51820\n"
                )

                bridge.save_configuration(sample_conf, "bogus")

                with open(app_conf_file, "r") as f:
                    import json
                    app_data = json.load(f)
                    self.assertEqual(app_data.get("target-node"), "lnd")
            finally:
                bridge.CONFIG_PATH = orig_conf
                bridge.APP_CONFIG_PATH = orig_app
                bridge.META_FILE_PATH = orig_meta

    def test_get_status_server_identifier(self):
        import tempfile
        with tempfile.TemporaryDirectory() as tmpdir:
            conf_file = os.path.join(tmpdir, "tunnelsatsv3.conf")
            orig_conf = bridge.CONFIG_PATH
            try:
                bridge.CONFIG_PATH = conf_file
                sample_conf = (
                    "[Interface]\n"
                    "PrivateKey = aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa=\n"
                    "Address = 10.9.0.2/32\n"
                    "# VPNPort: 24556\n"
                    "# Server: de2.tunnelsats.com\n"
                    "[Peer]\n"
                    "PublicKey = bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb=\n"
                    "Endpoint = 198.51.100.1:51820\n"
                )
                with open(conf_file, "w") as f:
                    f.write(sample_conf)

                status = bridge.get_status()
                # Ensure server is preferred from # Server: even when Endpoint is a raw IP
                self.assertEqual(status["server"], "de2.tunnelsats.com")
            finally:
                bridge.CONFIG_PATH = orig_conf

    def test_save_configuration_keeps_legacy_markers_byte_identical(self):
        # Configs written by earlier versions carry the markers of the retired
        # StartOS gateway model. The node task accepts the stored string
        # (trimmed, as the StartOS form submits it, or verbatim), so any
        # change inside it re-raises the task: it must be neither stripped
        # nor "completed".
        import json
        import tempfile
        body = (
            "PrivateKey = aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa=\n"
            "Address = 10.9.0.2/32\n"
            "# VPNPort: 24556\n"
            "\n"
            "[Peer]\n"
            "PublicKey = bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb=\n"
            "Endpoint = de2.tunnelsats.com:51820\n"
        )
        variants = (
            "[Interface]\n# StartTunnel\n# inbound: yes\n" + body,
            "[Interface]\n# Inbound: Yes\n" + body,
        )
        orig = (bridge.CONFIG_PATH, bridge.APP_CONFIG_PATH, bridge.META_FILE_PATH)
        try:
            for conf in variants:
                with self.subTest(conf=conf.splitlines()[1]), \
                        tempfile.TemporaryDirectory() as tmpdir:
                    bridge.CONFIG_PATH = os.path.join(tmpdir, "tunnelsatsv3.conf")
                    bridge.APP_CONFIG_PATH = os.path.join(tmpdir, "config.json")
                    bridge.META_FILE_PATH = os.path.join(tmpdir, "tunnelsats-meta.json")

                    bridge.save_configuration(conf, "lnd")

                    with open(bridge.CONFIG_PATH, "r") as f:
                        self.assertEqual(f.read(), conf)
                    with open(bridge.APP_CONFIG_PATH, "r") as f:
                        self.assertEqual(json.load(f)["tunnelsats-conf"], conf)
        finally:
            bridge.CONFIG_PATH, bridge.APP_CONFIG_PATH, bridge.META_FILE_PATH = orig
