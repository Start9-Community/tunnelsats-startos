import unittest
import os
import sys

# Add the parent directory to sys.path
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

import bridge

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

class TestPackageVersion(unittest.TestCase):
    def setUp(self):
        bridge._package_version_cache = None

    def tearDown(self):
        bridge._package_version_cache = None

    def test_get_package_version_from_version_json(self):
        ver = bridge.get_package_version()
        self.assertEqual(ver, "0.4.0")

    def test_get_package_version_from_env(self):
        with unittest.mock.patch.dict(os.environ, {"PACKAGE_VERSION": "1.2.3:4"}):
            bridge._package_version_cache = None
            ver = bridge.get_package_version()
            self.assertEqual(ver, "1.2.3")

class TestBridgeKeygenAndConfig(unittest.TestCase):
    def test_generate_wg_keypair(self):
        priv, pub = bridge.generate_wg_keypair()
        self.assertTrue(isinstance(priv, str) and len(priv) == 44)
        self.assertTrue(isinstance(pub, str) and len(pub) == 44)
        self.assertTrue(priv.endswith("="))
        self.assertTrue(pub.endswith("="))

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
                    self.assertIn("# StartTunnel\n", saved_conf)
                    self.assertIn("# inbound: yes\n", saved_conf)
                    self.assertIn("PrivateKey = aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa=\n", saved_conf)

                self.assertTrue(os.path.exists(app_conf_file))
                with open(app_conf_file, "r") as f:
                    import json
                    app_data = json.load(f)
                    self.assertTrue(app_data.get("enabled"))
                    self.assertEqual(app_data.get("target-node"), "cln")

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

    def test_ensure_inbound_markers_injection_and_preservation(self):
        conf_without = (
            "[Interface]\n"
            "PrivateKey = key=\n"
            "Address = 10.9.0.2/32\n"
        )
        marked = bridge.ensure_inbound_markers(conf_without)
        self.assertIn("# StartTunnel\n", marked)
        self.assertIn("# inbound: yes\n", marked)

        # Idempotent preservation
        self.assertEqual(bridge.ensure_inbound_markers(marked), marked)

        # Handles non-canonical casing by adding canonical # inbound: yes
        non_canon = (
            "[Interface]\n"
            "# StartTunnel\n"
            "# Inbound: Yes\n"
            "PrivateKey = key=\n"
        )
        marked_non_canon = bridge.ensure_inbound_markers(non_canon)
        self.assertIn("# inbound: yes\n", marked_non_canon)
        self.assertIn("# Inbound: Yes\n", marked_non_canon)
