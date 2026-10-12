"""Local test server with module MIME types independent of Windows registry."""
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import sys

SimpleHTTPRequestHandler.extensions_map.update({'.mjs': 'text/javascript', '.js': 'text/javascript', '.wasm': 'application/wasm'})
ThreadingHTTPServer(('127.0.0.1', int(sys.argv[1]) if len(sys.argv) > 1 else 8766), SimpleHTTPRequestHandler).serve_forever()
