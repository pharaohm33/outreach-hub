"""Tiny static server for the test pages that never caches (so edited files always reload).
Run from the project root:  python3 test/serve.py   then open http://127.0.0.1:8791/test/app.html?seed=1"""
import http.server

class NoCache(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

http.server.test(HandlerClass=NoCache, port=8791, bind="127.0.0.1")
