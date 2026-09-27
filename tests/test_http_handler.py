import unittest
import os
import sys
import json
from unittest.mock import patch, MagicMock
from io import BytesIO

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))
import bridge

class DummyHeaders:
    def __init__(self, headers):
        self.headers = {k.lower(): v for k, v in headers.items()}
    def get(self, name, default=None):
        return self.headers.get(name.lower(), default)
    def __contains__(self, name):
        return name.lower() in self.headers

class TestHTTPHandler(unittest.TestCase):
    @patch('bridge.get_default_gateway')
    @patch('socket.gethostbyname')
    @patch('bridge.get_status')
    @patch('bridge.get_wg_pubkey')
    def test_do_GET_api_status_authorization(self, mock_pubkey, mock_status, mock_gethostbyname, mock_get_gw):
        mock_get_gw.return_value = "172.18.0.1"
        mock_gethostbyname.return_value = "172.18.0.1"
        mock_pubkey.return_value = "pubkey123"
        mock_status.return_value = {
            "status": "running",
            "subscription_active": True
        }
        
        # Test local address: bypasses gateway check
        req = MagicMock()
        req.client_address = ("127.0.0.1", 12345)
        req.path = "/api/status"
        req.headers = DummyHeaders({"Host": "localhost"})
        
        wfile = BytesIO()
        req.wfile = wfile
        
        handler = bridge.DashboardHTTPRequestHandler.__new__(bridge.DashboardHTTPRequestHandler)
        handler.client_address = req.client_address
        handler.path = req.path
        handler.headers = req.headers
        handler.wfile = wfile
        handler.send_response = MagicMock()
        handler.send_header = MagicMock()
        handler.end_headers = MagicMock()
        handler.send_error = MagicMock()
        
        bridge.DashboardHTTPRequestHandler.do_GET(handler)
        
        # Should NOT have sent an error
        handler.send_error.assert_not_called()
        handler.send_response.assert_called_with(200)
        # The retired StartOS gateway model is not reported any more.
        payload = json.loads(wfile.getvalue())
        self.assertEqual(payload["status"], "running")
        self.assertNotIn("gateway_mode", payload)
        
        # Test local address with port and IPv6 formats
        for host in ["localhost:8080", "[::1]", "[::1]:8080", "127.0.0.1:8080"]:
            req_host = MagicMock()
            req_host.client_address = ("127.0.0.1", 12345)
            req_host.path = "/api/status"
            req_host.headers = DummyHeaders({"Host": host})
            wfile_host = BytesIO()
            handler_host = bridge.DashboardHTTPRequestHandler.__new__(bridge.DashboardHTTPRequestHandler)
            handler_host.client_address = req_host.client_address
            handler_host.path = req_host.path
            handler_host.headers = req_host.headers
            handler_host.wfile = wfile_host
            handler_host.send_response = MagicMock()
            handler_host.send_header = MagicMock()
            handler_host.end_headers = MagicMock()
            handler_host.send_error = MagicMock()
            
            bridge.DashboardHTTPRequestHandler.do_GET(handler_host)
            handler_host.send_error.assert_not_called()
            handler_host.send_response.assert_called_with(200)
        
        # Test untrusted subnet peer container: returns 403
        wfile_untrusted = BytesIO()
        handler_untrusted = bridge.DashboardHTTPRequestHandler.__new__(bridge.DashboardHTTPRequestHandler)
        handler_untrusted.client_address = ("172.18.0.3", 12345)
        handler_untrusted.path = "/api/status"
        handler_untrusted.headers = DummyHeaders({
            "Host": "tunnelsats.local",
            "X-Forwarded-For": "1.2.3.4",
            "X-Forwarded-Host": "tunnelsats.local"
        })
        handler_untrusted.wfile = wfile_untrusted
        handler_untrusted.send_response = MagicMock()
        handler_untrusted.send_header = MagicMock()
        handler_untrusted.end_headers = MagicMock()
        handler_untrusted.send_error = MagicMock()
        
        bridge.DashboardHTTPRequestHandler.do_GET(handler_untrusted)
        handler_untrusted.send_error.assert_called_with(403, "Access denied")
        
        # Test trusted embassy proxy IP (with standard .local Host): returns 200
        wfile_trusted = BytesIO()
        handler_trusted = bridge.DashboardHTTPRequestHandler.__new__(bridge.DashboardHTTPRequestHandler)
        handler_trusted.client_address = ("172.18.0.1", 12345)
        handler_trusted.path = "/api/status"
        handler_trusted.headers = DummyHeaders({
            "Host": "tunnelsats.local",
            "X-Forwarded-For": "1.2.3.4",
            "X-Forwarded-Host": "tunnelsats.local"
        })
        handler_trusted.wfile = wfile_trusted
        handler_trusted.send_response = MagicMock()
        handler_trusted.send_header = MagicMock()
        handler_trusted.end_headers = MagicMock()
        handler_trusted.send_error = MagicMock()
        
        bridge.DashboardHTTPRequestHandler.do_GET(handler_trusted)
        handler_trusted.send_error.assert_not_called()
        handler_trusted.send_response.assert_called_with(200)

        # Test trusted embassy proxy IP without proxy headers (e.g. startd proxy behavior): returns 200
        wfile_trusted_no_headers = BytesIO()
        handler_trusted_no_headers = bridge.DashboardHTTPRequestHandler.__new__(bridge.DashboardHTTPRequestHandler)
        handler_trusted_no_headers.client_address = ("172.18.0.1", 12345)
        handler_trusted_no_headers.path = "/api/status"
        handler_trusted_no_headers.headers = DummyHeaders({
            "Host": "tunnelsats.local"
        })
        handler_trusted_no_headers.wfile = wfile_trusted_no_headers
        handler_trusted_no_headers.send_response = MagicMock()
        handler_trusted_no_headers.send_header = MagicMock()
        handler_trusted_no_headers.end_headers = MagicMock()
        handler_trusted_no_headers.send_error = MagicMock()
        
        bridge.DashboardHTTPRequestHandler.do_GET(handler_trusted_no_headers)
        handler_trusted_no_headers.send_error.assert_not_called()
        handler_trusted_no_headers.send_response.assert_called_with(200)

        # Test trusted embassy proxy IP (with RFC 1918 private IP Host): returns 200
        wfile_ip = BytesIO()
        handler_ip = bridge.DashboardHTTPRequestHandler.__new__(bridge.DashboardHTTPRequestHandler)
        handler_ip.client_address = ("172.18.0.1", 12345)
        handler_ip.path = "/api/status"
        handler_ip.headers = DummyHeaders({
            "Host": "192.168.1.150:443",
            "X-Forwarded-For": "1.2.3.4",
            "X-Forwarded-Host": "192.168.1.150"
        })
        handler_ip.wfile = wfile_ip
        handler_ip.send_response = MagicMock()
        handler_ip.send_header = MagicMock()
        handler_ip.end_headers = MagicMock()
        handler_ip.send_error = MagicMock()
        
        bridge.DashboardHTTPRequestHandler.do_GET(handler_ip)
        handler_ip.send_error.assert_not_called()
        handler_ip.send_response.assert_called_with(200)

        # Test trusted embassy proxy IP (with RFC 4193 private IPv6 Host): returns 200
        wfile_ipv6_private = BytesIO()
        handler_ipv6_private = bridge.DashboardHTTPRequestHandler.__new__(bridge.DashboardHTTPRequestHandler)
        handler_ipv6_private.client_address = ("172.18.0.1", 12345)
        handler_ipv6_private.path = "/api/status"
        handler_ipv6_private.headers = DummyHeaders({
            "Host": "[fd00::1]:8443",
            "X-Forwarded-For": "1.2.3.4",
            "X-Forwarded-Host": "fd00::1"
        })
        handler_ipv6_private.wfile = wfile_ipv6_private
        handler_ipv6_private.send_response = MagicMock()
        handler_ipv6_private.send_header = MagicMock()
        handler_ipv6_private.end_headers = MagicMock()
        handler_ipv6_private.send_error = MagicMock()
        
        bridge.DashboardHTTPRequestHandler.do_GET(handler_ipv6_private)
        handler_ipv6_private.send_error.assert_not_called()
        handler_ipv6_private.send_response.assert_called_with(200)

        # Test trusted embassy proxy IP (with invalid public IPv6 Host): returns 403
        wfile_ipv6_public = BytesIO()
        handler_ipv6_public = bridge.DashboardHTTPRequestHandler.__new__(bridge.DashboardHTTPRequestHandler)
        handler_ipv6_public.client_address = ("172.18.0.1", 12345)
        handler_ipv6_public.path = "/api/status"
        handler_ipv6_public.headers = DummyHeaders({
            "Host": "[2001:4860:4860::8888]",
            "X-Forwarded-For": "1.2.3.4",
            "X-Forwarded-Host": "2001:4860:4860::8888"
        })
        handler_ipv6_public.wfile = wfile_ipv6_public
        handler_ipv6_public.send_response = MagicMock()
        handler_ipv6_public.send_header = MagicMock()
        handler_ipv6_public.end_headers = MagicMock()
        handler_ipv6_public.send_error = MagicMock()
        
        bridge.DashboardHTTPRequestHandler.do_GET(handler_ipv6_public)
        handler_ipv6_public.send_error.assert_called_with(403, "Access denied")

        # Test trusted embassy proxy IP (with invalid public IP Host): returns 403
        wfile_pub_ip = BytesIO()
        handler_pub_ip = bridge.DashboardHTTPRequestHandler.__new__(bridge.DashboardHTTPRequestHandler)
        handler_pub_ip.client_address = ("172.18.0.1", 12345)
        handler_pub_ip.path = "/api/status"
        handler_pub_ip.headers = DummyHeaders({
            "Host": "8.8.8.8",
            "X-Forwarded-For": "1.2.3.4",
            "X-Forwarded-Host": "8.8.8.8"
        })
        handler_pub_ip.wfile = wfile_pub_ip
        handler_pub_ip.send_response = MagicMock()
        handler_pub_ip.send_header = MagicMock()
        handler_pub_ip.end_headers = MagicMock()
        handler_pub_ip.send_error = MagicMock()
        
        bridge.DashboardHTTPRequestHandler.do_GET(handler_pub_ip)
        handler_pub_ip.send_error.assert_called_with(403, "Access denied")

    @patch('bridge.get_default_gateway')
    def test_do_POST_csrf_and_content_type_enforcement(self, mock_get_gw):
        mock_get_gw.return_value = "172.18.0.1"

        # 1. Reject POST without application/json (e.g. text/plain)
        handler = bridge.DashboardHTTPRequestHandler.__new__(bridge.DashboardHTTPRequestHandler)
        handler.command = "POST"
        handler.client_address = ("127.0.0.1", 12345)
        handler.path = "/api/config/save"
        handler.headers = DummyHeaders({
            "Host": "localhost",
            "Content-Type": "text/plain",
            "X-CSRF-Token": bridge.get_csrf_token()
        })
        handler.send_error = MagicMock()
        bridge.DashboardHTTPRequestHandler.do_POST(handler)
        handler.send_error.assert_called_with(415, "Unsupported Media Type: application/json required")

        # 2. Reject POST without custom CSRF header or with invalid token
        handler2 = bridge.DashboardHTTPRequestHandler.__new__(bridge.DashboardHTTPRequestHandler)
        handler2.command = "POST"
        handler2.client_address = ("127.0.0.1", 12345)
        handler2.path = "/api/config/save"
        handler2.headers = DummyHeaders({
            "Host": "localhost",
            "Content-Type": "application/json"
        })
        handler2.send_error = MagicMock()
        bridge.DashboardHTTPRequestHandler.do_POST(handler2)
        handler2.send_error.assert_called_with(403, "Invalid or missing CSRF token")

        handler2_invalid = bridge.DashboardHTTPRequestHandler.__new__(bridge.DashboardHTTPRequestHandler)
        handler2_invalid.command = "POST"
        handler2_invalid.client_address = ("127.0.0.1", 12345)
        handler2_invalid.path = "/api/config/save"
        handler2_invalid.headers = DummyHeaders({
            "Host": "localhost",
            "Content-Type": "application/json",
            "X-CSRF-Token": "invalid-token-123"
        })
        handler2_invalid.send_error = MagicMock()
        bridge.DashboardHTTPRequestHandler.do_POST(handler2_invalid)
        handler2_invalid.send_error.assert_called_with(403, "Invalid or missing CSRF token")

        # 3. Reject POST with cross-site Origin
        handler3 = bridge.DashboardHTTPRequestHandler.__new__(bridge.DashboardHTTPRequestHandler)
        handler3.command = "POST"
        handler3.client_address = ("127.0.0.1", 12345)
        handler3.path = "/api/config/save"
        handler3.headers = DummyHeaders({
            "Host": "localhost",
            "Content-Type": "application/json",
            "X-CSRF-Token": bridge.get_csrf_token(),
            "Origin": "https://evil.com"
        })
        handler3.send_error = MagicMock()
        bridge.DashboardHTTPRequestHandler.do_POST(handler3)
        handler3.send_error.assert_called_with(403, "Cross-origin request rejected")

        # 4. Reject POST with Sec-Fetch-Site: cross-site
        handler4 = bridge.DashboardHTTPRequestHandler.__new__(bridge.DashboardHTTPRequestHandler)
        handler4.command = "POST"
        handler4.client_address = ("127.0.0.1", 12345)
        handler4.path = "/api/config/save"
        handler4.headers = DummyHeaders({
            "Host": "localhost",
            "Content-Type": "application/json",
            "X-CSRF-Token": bridge.get_csrf_token(),
            "Sec-Fetch-Site": "cross-site"
        })
        handler4.send_error = MagicMock()
        bridge.DashboardHTTPRequestHandler.do_POST(handler4)
        handler4.send_error.assert_called_with(403, "Cross-site request rejected")

    @patch('os.path.exists')
    @patch('bridge.save_configuration')
    @patch('bridge.get_default_gateway')
    def test_do_POST_save_config_success(self, mock_get_gw, mock_save_config, mock_path_exists):
        mock_get_gw.return_value = "172.18.0.1"
        mock_path_exists.return_value = False

        req_body = json.dumps({
            "config": "[Interface]\nPrivateKey = abc=\n",
            "target_node": "lnd"
        }).encode("utf-8")

        handler = bridge.DashboardHTTPRequestHandler.__new__(bridge.DashboardHTTPRequestHandler)
        handler.command = "POST"
        handler.client_address = ("127.0.0.1", 12345)
        handler.path = "/api/config/save"
        handler.headers = DummyHeaders({
            "Host": "localhost",
            "Content-Type": "application/json",
            "Content-Length": str(len(req_body)),
            "X-CSRF-Token": bridge.get_csrf_token()
        })
        handler.rfile = BytesIO(req_body)
        wfile = BytesIO()
        handler.wfile = wfile
        handler.send_response = MagicMock()
        handler.send_header = MagicMock()
        handler.end_headers = MagicMock()

        bridge.DashboardHTTPRequestHandler.do_POST(handler)

        mock_save_config.assert_called_once_with("[Interface]\nPrivateKey = abc=", "lnd")
        handler.send_response.assert_called_with(200)
        res = json.loads(wfile.getvalue().decode("utf-8"))
        self.assertTrue(res.get("success"))
        self.assertEqual(res.get("message"), "Configuration saved. Accept the routing prompt on your Lightning node.")
        # Ensure it does NOT claim to have activated the configuration
        self.assertNotIn("activated", res.get("message").lower())

    @patch('bridge.get_subscription_info')
    @patch('os.path.exists')
    @patch('bridge.get_default_gateway')
    def test_do_POST_save_config_active_config_rejected(self, mock_get_gw, mock_path_exists, mock_sub_info):
        mock_get_gw.return_value = "172.18.0.1"
        mock_path_exists.return_value = True
        mock_sub_info.return_value = {
            "linked": True,
            "isExpired": False
        }

        req_body = json.dumps({
            "config": "[Interface]\nPrivateKey = attacker=\n",
            "target_node": "lnd"
        }).encode("utf-8")

        handler = bridge.DashboardHTTPRequestHandler.__new__(bridge.DashboardHTTPRequestHandler)
        handler.command = "POST"
        handler.client_address = ("127.0.0.1", 12345)
        handler.path = "/api/config/save"
        handler.headers = DummyHeaders({
            "Host": "localhost",
            "Content-Type": "application/json",
            "Content-Length": str(len(req_body)),
            "X-CSRF-Token": bridge.get_csrf_token()
        })
        handler.rfile = BytesIO(req_body)
        wfile = BytesIO()
        handler.wfile = wfile
        handler.send_response = MagicMock()
        handler.send_header = MagicMock()
        handler.end_headers = MagicMock()

        bridge.DashboardHTTPRequestHandler.do_POST(handler)

        handler.send_response.assert_called_with(403)
        res = json.loads(wfile.getvalue().decode("utf-8"))
        self.assertIn("Active configuration already present", res.get("error", ""))

    def _post_save_over_existing_config(self, sub_info):
        req_body = json.dumps({
            "config": "[Interface]\nPrivateKey = replacement=\n",
            "target_node": "lnd"
        }).encode("utf-8")

        handler = bridge.DashboardHTTPRequestHandler.__new__(bridge.DashboardHTTPRequestHandler)
        handler.command = "POST"
        handler.client_address = ("127.0.0.1", 12345)
        handler.path = "/api/config/save"
        handler.headers = DummyHeaders({
            "Host": "localhost",
            "Content-Type": "application/json",
            "Content-Length": str(len(req_body)),
            "X-CSRF-Token": bridge.get_csrf_token()
        })
        handler.rfile = BytesIO(req_body)
        handler.wfile = BytesIO()
        handler.send_response = MagicMock()
        handler.send_header = MagicMock()
        handler.end_headers = MagicMock()

        with patch('bridge.get_default_gateway', return_value="172.18.0.1"), \
             patch('os.path.exists', return_value=True), \
             patch('bridge.get_wg_pubkey', return_value="CURRENT_KEY") as mock_pubkey, \
             patch('bridge.get_subscription_info', return_value=sub_info) as mock_sub_info, \
             patch('bridge.save_configuration') as mock_save:
            bridge.DashboardHTTPRequestHandler.do_POST(handler)
        mock_pubkey.assert_called()
        mock_sub_info.assert_called_with("CURRENT_KEY")
        return handler, mock_save

    def test_do_POST_save_config_unconfirmed_subscription_rejected(self):
        # Fail closed: an unsynced / sync-failed subscription is not known to be
        # expired, so the unauthenticated web UI must not replace it.
        handler, mock_save = self._post_save_over_existing_config({
            "linked": False,
            "isExpired": False,
            "syncError": "unreachable",
        })
        handler.send_response.assert_called_with(403)
        mock_save.assert_not_called()

    def test_do_POST_save_config_expired_subscription_allowed(self):
        handler, mock_save = self._post_save_over_existing_config({
            "linked": True,
            "isExpired": True,
        })
        handler.send_response.assert_called_with(200)
        mock_save.assert_called_once_with("[Interface]\nPrivateKey = replacement=", "lnd")

    @patch('bridge.get_default_gateway')
    def test_do_GET_api_csrf(self, mock_get_gw):
        mock_get_gw.return_value = "172.18.0.1"

        handler = bridge.DashboardHTTPRequestHandler.__new__(bridge.DashboardHTTPRequestHandler)
        handler.client_address = ("127.0.0.1", 12345)
        handler.path = "/api/csrf"
        handler.headers = DummyHeaders({
            "Host": "localhost"
        })
        wfile = BytesIO()
        handler.wfile = wfile
        handler.send_response = MagicMock()
        handler.send_header = MagicMock()
        handler.end_headers = MagicMock()

        bridge.DashboardHTTPRequestHandler.do_GET(handler)

        handler.send_response.assert_called_with(200)
        res = json.loads(wfile.getvalue().decode("utf-8"))
        self.assertEqual(res.get("csrf_token"), bridge.get_csrf_token())

if __name__ == '__main__':
    unittest.main()
