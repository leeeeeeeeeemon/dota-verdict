# Локальный сервер «КТО ЗАРУНИЛ?»: статика + прокси к OpenDota API с кэшем.
# Прокси решает две проблемы: встроенные браузеры/блокировщики без доступа к api.opendota.com
# и лишние запросы (кэш на диске и в памяти снижает расход лимита 60 req/min).
import http.server
import json
import os
import socketserver
import sys
import threading
import time
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.abspath(__file__))
UPSTREAM = 'https://api.opendota.com/api'
PROXY_PREFIX = '/opendota/api'
CACHE_DIR = os.path.join(ROOT, 'fixtures', 'cache')
os.makedirs(CACHE_DIR, exist_ok=True)

# ttl по секциям url; по умолчанию 5 минут
TTL_RULES = [('/constants/', 7 * 86400), ('/heroes', 7 * 86400), ('/proMatches', 60)]
DEFAULT_TTL = 300
mem_cache = {}
mem_lock = threading.Lock()


def cache_key(url):
    return url.replace(UPSTREAM, '').replace('/', '_').replace('?', '_')[:150] + '.json'


def cache_get(url):
    key = cache_key(url)
    with mem_lock:
        hit = mem_cache.get(key)
    if hit and hit[0] > time.time():
        return hit[1]
    path = os.path.join(CACHE_DIR, key)
    if os.path.isfile(path) and time.time() - os.path.getmtime(path) < ttl_for(url):
        try:
            with open(path, 'rb') as f:
                body = f.read()
            with mem_lock:
                mem_cache[key] = (time.time() + ttl_for(url), body)
            return body
        except OSError:
            return None
    return None


def cache_put(url, body):
    key = cache_key(url)
    with mem_lock:
        mem_cache[key] = (time.time() + ttl_for(url), body)
    try:
        with open(os.path.join(CACHE_DIR, key), 'wb') as f:
            f.write(body)
    except OSError:
        pass


def ttl_for(url):
    for part, ttl in TTL_RULES:
        if part in url:
            return ttl
    return DEFAULT_TTL


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def log_message(self, fmt, *args):
        sys.stderr.write('%s - %s\n' % (self.address_string(), fmt % args))

    def do_GET(self):
        if self.path.startswith(PROXY_PREFIX):
            self.proxy('GET')
        else:
            super().do_GET()

    def do_POST(self):
        if self.path.startswith(PROXY_PREFIX):
            self.proxy('POST')
        else:
            self.send_error(405)

    def proxy(self, method):
        url = UPSTREAM + self.path[len(PROXY_PREFIX):]
        if method == 'GET':
            body = cache_get(url)
            if body is not None:
                self.reply(200, body)
                return
        req = urllib.request.Request(url, method=method, data=(b'' if method == 'POST' else None))
        req.add_header('User-Agent', 'kto-zaruinil/1.0')
        try:
            with urllib.request.urlopen(req, timeout=25) as r:
                body = r.read()
                status = r.status
        except urllib.error.HTTPError as e:
            body = e.read()
            status = e.code
        except Exception as e:
            self.reply(502, json.dumps({'error': str(e)}).encode('utf-8'))
            return
        if method == 'GET' and status == 200:
            cache_put(url, body)
        self.reply(status, body)

    def reply(self, status, body):
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    print('KTO-ZARUINIL server: http://127.0.0.1:%d  (proxy: %s/...)' % (port, PROXY_PREFIX))
    Server(('127.0.0.1', port), Handler).serve_forever()
