from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import os


PORT = int(os.environ.get("PORT", "4173"))


class GameRequestHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


def main():
    root = Path(__file__).resolve().parent
    os.chdir(root)
    server = ThreadingHTTPServer(("127.0.0.1", PORT), GameRequestHandler)
    print(f"Canberra Launch Program: http://127.0.0.1:{PORT}")
    server.serve_forever()


if __name__ == "__main__":
    main()
