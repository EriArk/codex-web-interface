FROM python:3.12-slim-bookworm@sha256:782412e85d0f0984994c290652577d4018aff08145c85b262bb63dc0c7522254
RUN apt-get update && apt-get install -y --no-install-recommends util-linux && rm -rf /var/lib/apt/lists/*
COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt
RUN pip install --no-cache-dir --index-url https://download.pytorch.org/whl/cpu torch==2.14.0
WORKDIR /app
COPY download.py download_silero.py server.py text_parts.py voices.json /app/
RUN python download.py && python download_silero.py && python -c "from server import synthesize; import wave,io; [synthesize('Проверка русского голоса и English words.', 'ru', voice=v) for v in ('ruslan','eugene','kseniya')]; print('Three Russian voices and English verified')"
ENV HOME=/tmp PYTHONDONTWRITEBYTECODE=1 OMP_NUM_THREADS=1 MKL_NUM_THREADS=1 OPENBLAS_NUM_THREADS=1
USER 1000:1000
CMD ["flock","--nonblock","--no-fork","/run/speech/worker.lock","python","/app/server.py"]
