import io, json, os, re, select, socket, socketserver, threading, time, wave
from http.server import BaseHTTPRequestHandler
from pathlib import Path
import onnxruntime
from piper import PiperVoice
from piper.config import PiperConfig

MAX_TEXT = 30000
MAX_AUDIO = 64 * 1024 * 1024
voices = {}
lock = threading.Lock()

def voice_for(language):
    if language not in voices:
        options = onnxruntime.SessionOptions()
        options.intra_op_num_threads = 1
        options.inter_op_num_threads = 1
        voices[language] = PiperVoice(
            session=onnxruntime.InferenceSession('/models/' + language + '.onnx', sess_options=options, providers=['CPUExecutionProvider']),
            config=PiperConfig.from_dict(json.loads(Path('/models/' + language + '.onnx.json').read_text())),
        )
    return voices[language]

def synthesize(text, language, cancelled=lambda: False):
    audio = io.BytesIO()
    started = time.monotonic()
    voice = voice_for(language)
    # Bound even unpunctuated text. Join all PCM into one real media track for background playback.
    with wave.open(audio, 'wb') as output:
        output.setnchannels(1); output.setsampwidth(2); output.setframerate(voice.config.sample_rate)
        parts = re.findall(r'.{1,500}(?:\s|$)|.{1,500}', text, flags=re.DOTALL)
        for part in parts:
            for chunk in voice.synthesize(part):
                if cancelled(): raise ConnectionResetError()
                if time.monotonic() - started > 150 or audio.tell() + len(chunk.audio_int16_bytes) > MAX_AUDIO:
                    raise ValueError('Speech limit exceeded')
                output.writeframesraw(chunk.audio_int16_bytes)
    return audio.getvalue()

class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    def log_message(self, *_): pass
    def reply(self, status, body=b'{}', mime='application/json'):
        self.send_response(status); self.send_header('Content-Type', mime)
        self.send_header('Content-Length', str(len(body))); self.send_header('Connection', 'close'); self.end_headers()
        self.wfile.write(body); self.close_connection = True
    def do_GET(self):
        self.reply(200 if self.path == '/health' else 404)
    def do_POST(self):
        if self.path != '/synthesize': self.reply(404); return
        if not lock.acquire(blocking=False): self.reply(409); return
        try:
            size = int(self.headers.get('Content-Length', '0'))
            if not 0 < size <= 128 * 1024: self.reply(413); return
            self.connection.settimeout(180)
            data = json.loads(self.rfile.read(size))
            text = data.get('text'); language = data.get('language')
            if not isinstance(text, str) or not text.strip() or len(text) > MAX_TEXT or language not in ['ru', 'en']:
                self.reply(400); return
            def cancelled():
                readable, _, _ = select.select([self.connection], [], [], 0)
                return bool(readable) and self.connection.recv(1, socket.MSG_PEEK) == b''
            self.reply(200, synthesize(text, language, cancelled), 'audio/wav')
        except (BrokenPipeError, ConnectionResetError): pass
        except Exception:
            try: self.reply(503)
            except OSError: pass
        finally: lock.release()

class Server(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True
    request_queue_size = 8

if __name__ == '__main__':
    os.umask(0o077)
    socket_path = Path('/run/speech/speech.sock')
    # flock in the entrypoint proves the old socket has no other worker owner.
    if socket_path.exists(): socket_path.unlink()
    with Server(str(socket_path), Handler) as server:
        print('Local speech worker ready', flush=True)
        server.serve_forever()
