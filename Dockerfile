FROM alpine:3.21

# Install system dependencies and distrust compromised eMudhra (emSign) root CAs
RUN apk add --no-cache \
    python3 \
    ca-certificates \
    bash \
    wireguard-tools \
    && sed -i 's|^mozilla/\(emSign_.*\.crt\)$|!mozilla/\1|' /etc/ca-certificates.conf \
    && rm -f /usr/share/ca-certificates/mozilla/emSign_*.crt /etc/ssl/certs/*emSign* \
    && update-ca-certificates --fresh

ENV SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt \
    REQUESTS_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt

# Set working directory
WORKDIR /app

# Copy application files
COPY version.json .
COPY bridge.py .
COPY docker_entrypoint.sh .
COPY verify.sh .
COPY web/ web/
RUN chmod +x docker_entrypoint.sh verify.sh

# StartOS data persistence directory
VOLUME /data

# Default entrypoint
ENTRYPOINT ["/app/docker_entrypoint.sh"]
