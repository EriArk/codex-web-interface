"""Publisher model used by books. Verify bytes before loading executable Torch packages."""
import hashlib
import json
from pathlib import Path
import urllib.request

FILES = {
    'silero-v5_5_ru.pt': (
        'https://models.silero.ai/models/tts/ru/v5_5_ru.pt', 145420684,
        '50081637b602126ee06cb3bc8a744d25651d2da149ee8864b9a379bfdd934437'),
    'silero-LICENSE': (
        'https://raw.githubusercontent.com/snakers4/silero-models/d9355348e2781dc8fa25a135d1602c530afae24c/LICENSE', None,
        '0b32da7bfc2ed1692fbd891bce070038cd8eb9afcc0237afc7de315a2de8ae6c'),
}

def download():
    root = Path('/models')
    root.mkdir(exist_ok=True)
    manifest = {}
    for name, (url, expected_size, expected_hash) in FILES.items():
        digest = hashlib.sha256()
        size = 0
        target = root / name
        with urllib.request.urlopen(url, timeout=120) as source, target.open('wb') as output:
            while chunk := source.read(1024 * 1024):
                size += len(chunk)
                if size > (expected_size or 20000): raise ValueError('Download size limit')
                digest.update(chunk)
                output.write(chunk)
        if (expected_size and size != expected_size) or digest.hexdigest() != expected_hash:
            target.unlink()
            raise ValueError('Unexpected publisher checksum')
        manifest[name] = {'url': url, 'bytes': size, 'sha256': digest.hexdigest()}
    (root / 'silero-manifest.json').write_text(json.dumps(manifest))

if __name__ == '__main__':
    download()
