import unittest
import os
import sys
import json
from unittest.mock import patch, MagicMock

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))
import bridge

class TestBridgeLifecycle(unittest.TestCase):
    @patch('os.path.exists')
    @patch('builtins.open', new_callable=unittest.mock.mock_open, read_data='[Interface]\nAddress = 10.9.9.9/32')
    def test_get_wg_ip_success(self, mock_open, mock_exists):
        mock_exists.return_value = True
        ip = bridge.get_wg_ip()
        self.assertEqual(ip, "10.9.9.9")

    @patch('os.path.exists')
    def test_get_wg_ip_failure(self, mock_exists):
        mock_exists.return_value = False
        ip = bridge.get_wg_ip()
        self.assertIsNone(ip)

    def test_extract_vpn_port_success(self):
        config = "[Interface]\n# VPNPort: 12345\nPrivateKey=..."
        port = bridge.extract_vpn_port(config)
        self.assertEqual(port, 12345)
        
    def test_extract_vpn_port_fallback(self):
        config = "[Interface]\nPrivateKey=..."
        port = bridge.extract_vpn_port(config)
        self.assertEqual(port, 9735)

    @patch('os.path.exists')
    @patch('builtins.open', new_callable=unittest.mock.mock_open, read_data='{"target-node": "cln"}')
    def test_get_target_details_cln(self, mock_open, mock_exists):
        mock_exists.return_value = True
        host, port = bridge.get_target_details()
        self.assertEqual(host, "c-lightning.embassy")
        self.assertEqual(port, 9735)

    @patch('os.path.exists')
    @patch('builtins.open', new_callable=unittest.mock.mock_open, read_data='{"target-node": "lnd"}')
    def test_get_target_details_lnd(self, mock_open, mock_exists):
        mock_exists.return_value = True
        host, port = bridge.get_target_details()
        self.assertEqual(host, "lnd.embassy")
        self.assertEqual(port, 9735)

    def test_validate_config_success(self):
        valid_conf = "[Interface]\nPrivateKey = hidden_key\nAddress = 10.x.x.x/32\n# VPNPort: 54321\n[Peer]\nEndpoint = 198.51.100.1:51820"
        bridge.validate_config(valid_conf) # Should not raise
        
    def test_validate_config_missing_privatekey(self):
        invalid_conf = "[Interface]\nAddress = 10.x.x.x/32\n# VPNPort: 54321\n[Peer]\nEndpoint = 198.51.100.1:51820"
        with self.assertRaisesRegex(ValueError, "Missing 'PrivateKey'"):
            bridge.validate_config(invalid_conf)
            
    def test_validate_config_missing_endpoint(self):
        invalid_conf = "[Interface]\nPrivateKey = hidden_key\nAddress = 10.x.x.x/32\n# VPNPort: 54321\n[Peer]\n"
        with self.assertRaisesRegex(ValueError, "Missing 'Endpoint'"):
            bridge.validate_config(invalid_conf)

    def test_validate_config_missing_vpnport(self):
        invalid_conf = "[Interface]\nPrivateKey = hidden_key\nAddress = 10.x.x.x/32\n[Peer]\nEndpoint = 198.51.100.1:51820"
        with self.assertRaisesRegex(ValueError, "Missing port-forwarding metadata"):
            bridge.validate_config(invalid_conf)

    def test_validate_config_with_port_forwarding_tag(self):
        valid_conf = "[Interface]\nPrivateKey = hidden_key\nAddress = 10.x.x.x/32\n# Port Forwarding: 54321\n[Peer]\nEndpoint = 198.51.100.1:51820"
        bridge.validate_config(valid_conf)

    @patch('urllib.request.urlopen')
    def test_lazy_sync_success(self, mock_urlopen):
        import tempfile
        with tempfile.TemporaryDirectory() as tmpdir:
            meta_file = os.path.join(tmpdir, "tunnelsats-meta.json")
            orig_meta = bridge.META_FILE_PATH
            try:
                bridge.META_FILE_PATH = meta_file
                mock_response = MagicMock()
                mock_response.status = 200
                mock_response.read.return_value = b'{"expiry": "2026-12-31T23:59:59Z", "server_domain": "ch1.tunnelsats.com", "vpn_port": 24556}'
                mock_response.__enter__ = lambda s: s
                mock_response.__exit__ = MagicMock(return_value=False)
                mock_urlopen.return_value = mock_response

                with patch('bridge.get_wg_pubkey', return_value="mock_pubkey_123"):
                    self.assertEqual(bridge.lazy_sync("mock_pubkey_123"), "confirmed")

                self.assertTrue(os.path.exists(meta_file))
                with open(meta_file, "r") as f:
                    parsed_written = json.load(f)
                self.assertEqual(parsed_written["expiresAt"], "2026-12-31T23:59:59Z")
                self.assertEqual(parsed_written["serverDomain"], "ch1.tunnelsats.com")
                self.assertEqual(parsed_written["vpnPort"], 24556)
                self.assertTrue(parsed_written["syncSuccess"])
                self.assertEqual(os.stat(meta_file).st_mode & 0o777, 0o600)
            finally:
                bridge.META_FILE_PATH = orig_meta

if __name__ == '__main__':
    unittest.main()
