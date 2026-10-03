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
        req.path = "/api/dashboard"
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
            req_host.path = "/api/dashboard"
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
        handler_untrusted.path = "/api/dashboard"
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
        handler_trusted.path = "/api/dashboard"
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
        handler_trusted_no_headers.path = "/api/dashboard"
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
        handler_ip.path = "/api/dashboard"
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
        handler_ipv6_private.path = "/api/dashboard"
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
        handler_ipv6_public.path = "/api/dashboard"
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
        handler_pub_ip.path = "/api/dashboard"
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

        # 5. Accept IPv6 literal Origin for local and trusted private IPv6 hosts, reject public IPv6 Origin
        handler_ipv6_local = bridge.DashboardHTTPRequestHandler.__new__(bridge.DashboardHTTPRequestHandler)
        handler_ipv6_local.command = "POST"
        handler_ipv6_local.client_address = ("127.0.0.1", 12345)
        handler_ipv6_local.path = "/api/intents"
        handler_ipv6_local.headers = DummyHeaders({
            "Host": "[::1]:8080",
            "Origin": "http://[::1]:8080",
            "Content-Type": "application/json",
            "X-CSRF-Token": bridge.get_csrf_token(),
        })
        handler_ipv6_local.send_error = MagicMock()
        self.assertTrue(bridge.DashboardHTTPRequestHandler.is_trusted_request(handler_ipv6_local))

        handler_ipv6_priv = bridge.DashboardHTTPRequestHandler.__new__(bridge.DashboardHTTPRequestHandler)
        handler_ipv6_priv.command = "POST"
        handler_ipv6_priv.client_address = ("172.18.0.1", 12345)
        handler_ipv6_priv.path = "/api/intents"
        handler_ipv6_priv.headers = DummyHeaders({
            "Host": "[fd00::1]:8443",
            "X-Forwarded-For": "1.2.3.4",
            "X-Forwarded-Host": "fd00::1",
            "Origin": "https://[fd00::1]:8443",
            "Content-Type": "application/json",
            "X-CSRF-Token": bridge.get_csrf_token(),
        })
        handler_ipv6_priv.send_error = MagicMock()
        with patch("socket.gethostbyname", return_value="172.18.0.1"):
            self.assertTrue(bridge.DashboardHTTPRequestHandler.is_trusted_request(handler_ipv6_priv))

        handler_ipv6_pub = bridge.DashboardHTTPRequestHandler.__new__(bridge.DashboardHTTPRequestHandler)
        handler_ipv6_pub.command = "POST"
        handler_ipv6_pub.client_address = ("172.18.0.1", 12345)
        handler_ipv6_pub.path = "/api/intents"
        handler_ipv6_pub.headers = DummyHeaders({
            "Host": "tunnelsats.local",
            "X-Forwarded-For": "1.2.3.4",
            "X-Forwarded-Host": "tunnelsats.local",
            "Origin": "https://[2001:4860:4860::8888]:8443",
            "Content-Type": "application/json",
            "X-CSRF-Token": bridge.get_csrf_token(),
        })
        handler_ipv6_pub.send_error = MagicMock()
        with patch("socket.gethostbyname", return_value="172.18.0.1"):
            self.assertFalse(bridge.DashboardHTTPRequestHandler.is_trusted_request(handler_ipv6_pub))
        handler_ipv6_pub.send_error.assert_called_once_with(403, "Cross-origin request rejected")

    @patch('bridge.save_configuration')
    @patch('bridge.get_default_gateway')
    def test_removed_write_endpoints_return_404(self, mock_get_gw, mock_save_config):
        mock_get_gw.return_value = "172.18.0.1"
        req_body = json.dumps({
            "config": "[Interface]\nPrivateKey = abc=\n",
            "target_node": "lnd",
        }).encode("utf-8")

        for path in ("/api/keys/generate", "/api/config/save"):
            with self.subTest(path=path):
                handler = bridge.DashboardHTTPRequestHandler.__new__(bridge.DashboardHTTPRequestHandler)
                handler.command = "POST"
                handler.client_address = ("127.0.0.1", 12345)
                handler.path = path
                handler.headers = DummyHeaders({
                    "Host": "localhost",
                    "Content-Type": "application/json",
                    "Content-Length": str(len(req_body)),
                    "X-CSRF-Token": bridge.get_csrf_token(),
                })
                handler.rfile = BytesIO(req_body)
                handler.wfile = BytesIO()
                handler.send_response = MagicMock()
                handler.send_header = MagicMock()
                handler.end_headers = MagicMock()
                handler.send_error = MagicMock()

                bridge.DashboardHTTPRequestHandler.do_POST(handler)

                handler.send_error.assert_called_once_with(404, "Not found")
                handler.send_response.assert_not_called()
        mock_save_config.assert_not_called()

    @patch('bridge.get_default_gateway')
    def test_removed_get_endpoints_return_404_and_http_hardening_configured(self, mock_get_gw):
        mock_get_gw.return_value = "172.18.0.1"

        self.assertEqual(bridge.DashboardHTTPRequestHandler.timeout, 10)
        self.assertTrue(bridge.DashboardHTTPServer.daemon_threads)

        for path in ("/api/status", "/api/csrf"):
            with self.subTest(path=path):
                handler = bridge.DashboardHTTPRequestHandler.__new__(bridge.DashboardHTTPRequestHandler)
                handler.client_address = ("127.0.0.1", 12345)
                handler.path = path
                handler.headers = DummyHeaders({
                    "Host": "localhost"
                })
                handler.wfile = BytesIO()
                handler.send_response = MagicMock()
                handler.send_header = MagicMock()
                handler.end_headers = MagicMock()
                handler.send_error = MagicMock()

                bridge.DashboardHTTPRequestHandler.do_GET(handler)

                handler.send_error.assert_called_once_with(404, "File not found")
                handler.send_response.assert_not_called()

    @patch('bridge.submit_dashboard_intent')
    @patch('bridge.get_default_gateway')
    def test_do_POST_api_intents_body_guards(self, mock_get_gw, mock_submit):
        mock_get_gw.return_value = "172.18.0.1"
        mock_submit.return_value = (202, {"status": "accepted"})

        # Oversized body rejected with 400
        handler_big = bridge.DashboardHTTPRequestHandler.__new__(bridge.DashboardHTTPRequestHandler)
        handler_big.command = "POST"
        handler_big.client_address = ("127.0.0.1", 12345)
        handler_big.path = "/api/intents"
        handler_big.headers = DummyHeaders({
            "Host": "localhost",
            "Content-Type": "application/json",
            "Content-Length": str(bridge.INTENT_MAX_BODY_BYTES + 1),
            "X-CSRF-Token": bridge.get_csrf_token(),
        })
        handler_big.rfile = BytesIO(b"{}")
        handler_big.wfile = BytesIO()
        handler_big.send_response = MagicMock()
        handler_big.send_header = MagicMock()
        handler_big.end_headers = MagicMock()
        handler_big.send_error = MagicMock()
        bridge.DashboardHTTPRequestHandler.do_POST(handler_big)
        handler_big.send_response.assert_called_once_with(400)
        mock_submit.assert_not_called()

        # Valid JSON body calls submit_dashboard_intent
        valid_body = b'{"kind":"buy","serverId":"eu-de","duration":"3m"}'
        handler_ok = bridge.DashboardHTTPRequestHandler.__new__(bridge.DashboardHTTPRequestHandler)
        handler_ok.command = "POST"
        handler_ok.client_address = ("127.0.0.1", 12345)
        handler_ok.path = "/api/intents"
        handler_ok.headers = DummyHeaders({
            "Host": "localhost",
            "Content-Type": "application/json",
            "Content-Length": str(len(valid_body)),
            "X-CSRF-Token": bridge.get_csrf_token(),
        })
        handler_ok.rfile = BytesIO(valid_body)
        handler_ok.wfile = BytesIO()
        handler_ok.send_response = MagicMock()
        handler_ok.send_header = MagicMock()
        handler_ok.end_headers = MagicMock()
        handler_ok.send_error = MagicMock()
        bridge.DashboardHTTPRequestHandler.do_POST(handler_ok)
        handler_ok.send_response.assert_called_once_with(202)
        mock_submit.assert_called_once_with({"kind": "buy", "serverId": "eu-de", "duration": "3m"})

if __name__ == '__main__':
    unittest.main()
