FROM python:3.12-slim

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY netmanager_mcp.py .

ENV NETMANAGER_URL=http://backend:8000
ENV NETMANAGER_USERNAME=admin
ENV NETMANAGER_PASSWORD=""

# MCP stdio mode — the container is exec'd into, not run as a daemon
CMD ["python", "netmanager_mcp.py"]
