import unittest
import os
import sys
import json
from unittest.mock import patch, MagicMock
from datetime import datetime, timezone

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))
import bridge

class TestBridgeStatus(unittest.TestCase):
    @patch('bridge.is_allow_ipv6', return_value=False)
    @patch('bridge.is_enabled', return_value=True)
    @patch('bridge.get_wg_ip', return_value="10.9.0.102")
    @patch('bridge.get_wg_pubkey', return_value="TEST_PUBKEY_123")
    @patch('os.path.exists')
    @patch('builtins.open')
    def test_status_running_active(self, mock_open, mock_exists, mock_pubkey, mock_ip, mock_enabled, mock_ipv6):
        def exists_side_effect(path):
            return path in (bridge.CONFIG_PATH, bridge.META_FILE_PATH)
        mock_exists.side_effect = exists_side_effect
        
        config_data = '[Interface]\nAddress = 10.9.0.102/32\n# VPNPort: 24556\n[Peer]\nEndpoint = ch1.tunnelsats.com:51820'
        meta_data = json.dumps({
            "expiresAt": "2026-12-31T23:59:59Z",
            "expirySource": "api",
            "publicKey": "TEST_PUBKEY_123",
            "lastSync": "2026-08-20T18:00:00Z"
        })
        
        def open_side_effect(path, *args, **kwargs):
            if path == bridge.CONFIG_PATH:
                return unittest.mock.mock_open(read_data=config_data)()
            elif path == bridge.META_FILE_PATH:
                return unittest.mock.mock_open(read_data=meta_data)()
            return unittest.mock.mock_open()()
            
        mock_open.side_effect = open_side_effect
        
        with patch('bridge.datetime') as mock_dt:
            mock_dt.now.return_value = datetime(2026, 8, 20, 18, 0, 0, tzinfo=timezone.utc)
            mock_dt.fromisoformat.side_effect = lambda s: datetime.fromisoformat(s)
            
            status = bridge.get_status()
            self.assertEqual(status["status"], "running")
            self.assertTrue(status["enabled"])
            self.assertTrue(status["configured"])
            self.assertTrue(status["subscription_active"])
            self.assertNotIn("gateway_mode", status)
            self.assertEqual(status["vpn_ip"], "10.9.0.102")
            self.assertEqual(status["vpn_port"], 24556)
            self.assertEqual(status["server"], "ch1.tunnelsats.com")
            self.assertEqual(status["internal_octet"], "102")
            self.assertEqual(status["pubkey"], "TEST_PUBKEY_123")
            self.assertTrue(status["subscription_linked"])
            self.assertGreater(status["days_remaining"], 0)

    @patch('bridge.is_enabled', return_value=False)
    def test_status_disabled(self, mock_enabled):
        status = bridge.get_status()
        self.assertEqual(status["status"], "disabled")
        self.assertFalse(status["enabled"])
        self.assertFalse(status["subscription_active"])

    @patch('bridge.is_enabled', return_value=True)
    @patch('os.path.exists', return_value=False)
    def test_status_unconfigured(self, mock_exists, mock_enabled):
        status = bridge.get_status()
        self.assertEqual(status["status"], "unconfigured")
        self.assertTrue(status["enabled"])
        self.assertFalse(status["configured"])
        self.assertFalse(status["subscription_active"])

    @patch('bridge.is_allow_ipv6', return_value=False)
    @patch('bridge.is_enabled', return_value=True)
    @patch('bridge.get_wg_ip', return_value="10.9.0.102")
    @patch('bridge.get_wg_pubkey', return_value="TEST_PUBKEY_123")
    @patch('os.path.exists')
    @patch('builtins.open')
    def test_status_expired(self, mock_open, mock_exists, mock_pubkey, mock_ip, mock_enabled, mock_ipv6):
        def exists_side_effect(path):
            return path in (bridge.CONFIG_PATH, bridge.META_FILE_PATH)
        mock_exists.side_effect = exists_side_effect
        
        config_data = '[Interface]\nAddress = 10.9.0.102/32\n# VPNPort: 24556\n[Peer]\nEndpoint = ch1.tunnelsats.com:51820'
        meta_data = json.dumps({
            "expiresAt": "2026-01-01T00:00:00Z",
            "expirySource": "api",
            "publicKey": "TEST_PUBKEY_123",
            "lastSync": "2026-08-20T18:00:00Z"
        })
        
        def open_side_effect(path, *args, **kwargs):
            if path == bridge.CONFIG_PATH:
                return unittest.mock.mock_open(read_data=config_data)()
            elif path == bridge.META_FILE_PATH:
                return unittest.mock.mock_open(read_data=meta_data)()
            return unittest.mock.mock_open()()
            
        mock_open.side_effect = open_side_effect
        
        with patch('bridge.datetime') as mock_dt:
            mock_dt.now.return_value = datetime(2026, 8, 20, 18, 0, 0, tzinfo=timezone.utc)
            mock_dt.fromisoformat.side_effect = lambda s: datetime.fromisoformat(s)
            
            status = bridge.get_status()
            self.assertEqual(status["status"], "expired")
            self.assertFalse(status["subscription_active"])
            self.assertEqual(status["days_remaining"], 0)
            self.assertIn("Expired on", status["expiry_formatted"])

    @patch('bridge.is_allow_ipv6', return_value=False)
    @patch('bridge.is_enabled', return_value=True)
    @patch('bridge.get_wg_ip', return_value="10.9.0.102")
    @patch('bridge.get_wg_pubkey', return_value="NEW_PUBKEY")
    @patch('os.path.exists')
    @patch('builtins.open')
    def test_status_ignores_expiry_confirmed_for_previous_key(self, mock_open, mock_exists, mock_pubkey, mock_ip, mock_enabled, mock_ipv6):
        mock_exists.side_effect = lambda path: path in (bridge.CONFIG_PATH, bridge.META_FILE_PATH)
        config_data = '[Interface]\nAddress = 10.9.0.102/32\n[Peer]\nEndpoint = ch1.tunnelsats.com:51820'
        meta_data = json.dumps({
            "expiresAt": "2026-12-31T23:59:59Z",
            "expirySource": "api",
            "publicKey": "OLD_PUBKEY",
            "lastSync": "2026-08-20T18:00:00Z",
            "syncSuccess": True,
        })

        def open_side_effect(path, *args, **kwargs):
            if path == bridge.CONFIG_PATH:
                return unittest.mock.mock_open(read_data=config_data)()
            elif path == bridge.META_FILE_PATH:
                return unittest.mock.mock_open(read_data=meta_data)()
            return unittest.mock.mock_open()()
        mock_open.side_effect = open_side_effect

        status = bridge.get_status()
        self.assertEqual(status["status"], "pending_sync")
        self.assertFalse(status["subscription_active"])
        self.assertFalse(status["subscription_linked"])
        self.assertEqual(status["expires_at"], "Unknown")
        self.assertIsNone(status["days_remaining"])

if __name__ == '__main__':
    unittest.main()
