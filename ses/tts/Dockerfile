FROM python:3.11-slim
ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 HF_HOME=/model
RUN apt-get update && apt-get install -y --no-install-recommends libsndfile1 \
    && rm -rf /var/lib/apt/lists/*
# chatterbox-tts, torch 2.6 (CUDA 12.4) ile gelir; sürücü 580 bunu çalıştırır
RUN pip install chatterbox-tts==0.1.7 "fastapi>=0.115" "uvicorn>=0.30" "lingua-language-detector>=2.0"
WORKDIR /app
COPY server.py .
EXPOSE 8000
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8000"]
