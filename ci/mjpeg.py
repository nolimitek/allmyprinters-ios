# Kleiner MJPEG-Strom für den Simulator-Lauf: /stream (multipart/x-mixed-replace) und /snap (Einzelbild), Port 8765
import http.server, socketserver, sys, time
img = open(sys.argv[1], 'rb').read()
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        if self.path.startswith('/snap'):
            self.send_response(200); self.send_header('Content-Type', 'image/jpeg'); self.send_header('Content-Length', str(len(img))); self.end_headers(); self.wfile.write(img); return
        self.send_response(200); self.send_header('Content-Type', 'multipart/x-mixed-replace; boundary=amp'); self.end_headers()
        try:
            for _ in range(600):
                self.wfile.write(b'--amp\r\nContent-Type: image/jpeg\r\nContent-Length: %d\r\n\r\n' % len(img) + img + b'\r\n'); self.wfile.flush(); time.sleep(0.2)
        except Exception: pass
class S(socketserver.ThreadingMixIn, http.server.HTTPServer): daemon_threads = True
S(('127.0.0.1', 8765), H).serve_forever()
