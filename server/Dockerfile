# Relay image: stdlib-only Python, no dependencies to install, no build step.
FROM python:3.12-slim

WORKDIR /srv/relay
COPY server/spike_server.py server/seed-state.json server/entrypoint.sh ./
COPY docs ./docs
RUN chmod +x entrypoint.sh

# /data holds state.json + events.jsonl and must survive container replacement,
# so it is a named volume in compose. Writable by the unprivileged user.
RUN mkdir -p /data && chown -R nobody:nogroup /data /srv/relay
USER nobody

EXPOSE 8097

HEALTHCHECK --interval=60s --timeout=5s --retries=3 \
  CMD python3 -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8097/health', timeout=3).status == 200 else 1)"

ENTRYPOINT ["/srv/relay/entrypoint.sh"]
CMD ["--host", "0.0.0.0", "--port", "8097", "--state", "/data/state.json", "--log", "/data/events.jsonl"]
