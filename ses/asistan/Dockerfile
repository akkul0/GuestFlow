FROM python:3.12-slim
ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
RUN pip install "pipecat-ai[openai,ollama,runner,silero,webrtc]==1.15.0" "httpx>=0.27"
WORKDIR /app
COPY bot.py .
# Test sayfası yalnızca bu bilgisayardan açılır: http://127.0.0.1:7860
CMD ["python", "bot.py", "--host", "127.0.0.1", "--port", "7860"]
