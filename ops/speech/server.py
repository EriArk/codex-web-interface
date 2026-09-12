import contextlib, html, io, json, os, re, select, socket, socketserver, threading, time, wave
from http.server import BaseHTTPRequestHandler
from pathlib import Path
import onnxruntime
import numpy as np
from piper import PiperVoice, SynthesisConfig
from piper.config import PiperConfig
from text_parts import language_parts, spoken_english

MAX_TEXT = 30000
MAX_AUDIO = 64 * 1024 * 1024
voices = {}
lock = threading.Lock()
VOICE_IDS = ('eugene', 'kseniya', 'ruslan')
SAMPLE_RATE = 24000

def silero_voice():
    if 'silero' not in voices:
        import torch
        torch.set_num_threads(1)
        model = torch.package.PackageImporter('/models/silero-v5_5_ru.pt').load_pickle('tts_models', 'model')
        model.to(torch.device('cpu'))
        voices['silero'] = model
    return voices['silero']

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

def samples_for(text, language, voice):
    if language == 'ru' and voice != 'ruslan':
        import torch
        model = silero_voice()
        with torch.inference_mode():
            samples = model.apply_tts(
                ssml_text='<speak><prosody rate="slow">' + html.escape(text) + '</prosody></speak>',
                speaker=voice, sample_rate=SAMPLE_RATE, put_accent=True, put_yo=True)
        return samples.detach().cpu().numpy(), SAMPLE_RATE
    model = voice_for(language)
    config = SynthesisConfig(length_scale=1.16, noise_scale=0.45, noise_w_scale=0.55, normalize_audio=False)
    pieces = [np.frombuffer(chunk.audio_int16_bytes, dtype='<i2').astype(np.float32) / 32768
              for chunk in model.synthesize(spoken_english(text) if language == 'en' else text, syn_config=config)]
    return np.concatenate(pieces) if pieces else np.zeros(0, dtype=np.float32), model.config.sample_rate

def prepare_samples(samples, rate):
    if not len(samples):
        return samples
    if rate != SAMPLE_RATE:
        # Polyphase, band-limited resampling preserves pitch when mixing 22.05/24 kHz voices.
        import soxr
        samples = soxr.resample(samples, rate, SAMPLE_RATE, quality='HQ')
    samples = np.nan_to_num(samples, nan=0.0, posinf=0.0, neginf=0.0)
    active = np.flatnonzero(np.abs(samples) > 0.008)
    if not len(active):
        return np.zeros(0, dtype=np.float32)
    # Retain quiet consonants; remove only outer silence before adding a deliberate pause.
    margin = int(SAMPLE_RATE * 0.045)
    samples = samples[max(0, active[0] - margin):min(len(samples), active[-1] + margin + 1)].copy()
    rms = np.sqrt(np.mean(samples * samples))
    gain = min(2.5, 0.11 / max(float(rms), 0.001), 0.94 / max(float(np.max(np.abs(samples))), 0.001))
    samples *= gain
    fade = min(int(SAMPLE_RATE * 0.004), len(samples) // 2)
    if fade:
        samples[:fade] *= np.linspace(0, 1, fade)
        samples[-fade:] *= np.linspace(1, 0, fade)
    return samples

def synthesize(text, language, cancelled=lambda: False, voice='eugene'):
    if voice not in VOICE_IDS or language not in ('ru', 'en'):
        raise ValueError('Invalid voice')
    audio = io.BytesIO()
    started = time.monotonic()
    def check():
        if cancelled(): raise ConnectionResetError()
        if time.monotonic() - started > 150 or audio.tell() > MAX_AUDIO:
            raise ValueError('Speech limit exceeded')
    # One WAV, not a browser-side playlist: language switches also work with a locked screen.
    with wave.open(audio, 'wb') as output:
        output.setnchannels(1); output.setsampwidth(2); output.setframerate(SAMPLE_RATE)
        for part_language, part in language_parts(text, language):
            check()
            if not re.search(r'\w', part): continue
            # Third-party normalizers must not print message text into container logs.
            with open(os.devnull, 'w') as silent, contextlib.redirect_stdout(silent), contextlib.redirect_stderr(silent):
                samples, rate = samples_for(part, part_language, voice)
            check()
            samples = prepare_samples(samples, rate)
            pause = 0.32 if '\n\n' in part[-4:] else 0.22 if re.search(r'[.!?…][\s\"»”]*$', part) else 0.10 if re.search(r'[,;:][\s\"»”]*$', part) else 0.025
            frames = (np.clip(samples, -1, 1) * 32767).astype('<i2').tobytes()
            padding = b'\0\0' * int(pause * SAMPLE_RATE)
            if audio.tell() + len(frames) + len(padding) > MAX_AUDIO: raise ValueError('Speech limit exceeded')
            output.writeframesraw(frames + padding)
        if output.getnframes() == 0: raise ValueError('No speech')
    return audio.getvalue()

class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    def log_message(self, *_): pass
    def reply(self, status, body=b'{}', mime='application/json'):
        self.send_response(status); self.send_header('Content-Type', mime)
        self.send_header('Content-Length', str(len(body))); self.send_header('Connection', 'close'); self.end_headers()
        self.wfile.write(body); self.close_connection = True
    def do_GET(self):
        self.reply(200, json.dumps({'voices': VOICE_IDS, 'defaultVoice': 'eugene', 'mixedLanguage': True}).encode()) if self.path == '/health' else self.reply(404)
    def do_POST(self):
        if self.path != '/synthesize': self.reply(404); return
        if not lock.acquire(blocking=False): self.reply(409); return
        try:
            size = int(self.headers.get('Content-Length', '0'))
            if not 0 < size <= 128 * 1024: self.reply(413); return
            self.connection.settimeout(180)
            data = json.loads(self.rfile.read(size))
            if not isinstance(data, dict): self.reply(400); return
            text = data.get('text'); language = data.get('language'); voice = data.get('voice', 'eugene')
            if not isinstance(text, str) or not text.strip() or len(text) > MAX_TEXT or language not in ['ru', 'en'] or voice not in VOICE_IDS:
                self.reply(400); return
            def cancelled():
                readable, _, _ = select.select([self.connection], [], [], 0)
                return bool(readable) and self.connection.recv(1, socket.MSG_PEEK) == b''
            self.reply(200, synthesize(text, language, cancelled, voice), 'audio/wav')
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
        socket_path.chmod(0o600)
        print('Local speech worker ready', flush=True)
        server.serve_forever()
