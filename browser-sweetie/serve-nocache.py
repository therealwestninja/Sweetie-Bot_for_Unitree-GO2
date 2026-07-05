"""Dev static server that sends Cache-Control: no-store, so edited ES modules are always refetched (the stock
python http.server sends no cache headers, and Chrome then heuristically caches modules → stale reloads).
Serves the current working directory (the launch runs it from the D:\\Claude repo root)."""
import http.server
import sys


class NoCache(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        super().end_headers()


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8017
    http.server.HTTPServer(("", port), NoCache).serve_forever()
