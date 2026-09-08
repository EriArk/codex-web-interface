FROM python:3.12-slim-bookworm@sha256:782412e85d0f0984994c290652577d4018aff08145c85b262bb63dc0c7522254
RUN apt-get update && apt-get install -y --no-install-recommends util-linux && rm -rf /var/lib/apt/lists/*
COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt
WORKDIR /app
COPY download.py server.py voices.json /app/
RUN python download.py && python -c "from server import synthesize; import wave,io; a=synthesize('Проверка чтения ответа.', 'ru'); w=wave.open(io.BytesIO(a)); assert w.getnframes()>1000; b=synthesize('Reading a response.', 'en'); assert len(b)>1000; print('Russian and English voices verified')"
ENV HOME=/tmp PYTHONDONTWRITEBYTECODE=1 OMP_NUM_THREADS=1
USER 1000:1000
CMD ["flock","--nonblock","--no-fork","/run/speech/worker.lock","python","/app/server.py"]
