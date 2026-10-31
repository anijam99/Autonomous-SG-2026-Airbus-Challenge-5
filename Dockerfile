# Gatehold: web app image (FastAPI + D3). Models and data are prebuilt in data/.
FROM python:3.14-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 HOST=0.0.0.0 PORT=8600
# LightGBM needs the OpenMP runtime
RUN apt-get update && apt-get install -y --no-install-recommends libgomp1 curl && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements-app.txt .
RUN pip install --no-cache-dir -r requirements-app.txt

COPY app/ app/
COPY src/ src/
COPY data/model/ data/model/
COPY data/processed/ data/processed/
COPY data/challenge/ data/challenge/
COPY data/jev/ data/jev/
COPY data/external/ data/external/
COPY Flight_Data_With_Weather_Final.csv .

RUN useradd --create-home appuser && mkdir -p /app/logs && chown -R appuser /app/logs
USER appuser

EXPOSE 8600
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 CMD curl -fs http://localhost:${PORT}/api/meta > /dev/null || exit 1
CMD ["python", "app/server.py"]
