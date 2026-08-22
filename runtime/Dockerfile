FROM node:24.19.0-bookworm-slim

ARG DEBIAN_FRONTEND=noninteractive
ARG PLATFORMIO_VERSION=6.1.19

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        bash \
        build-essential \
        ca-certificates \
        cmake \
        curl \
        git \
        gnupg \
        ninja-build \
        python3 \
        python3-pip \
        python3-venv \
        ripgrep \
        unzip \
        wget \
        xz-utils \
    && rm -rf /var/lib/apt/lists/*

RUN useradd --create-home --shell /bin/bash vscode

RUN python3 -m venv /opt/platformio \
    && /opt/platformio/bin/pip install --no-cache-dir --upgrade pip \
    && /opt/platformio/bin/pip install --no-cache-dir "platformio==${PLATFORMIO_VERSION}" \
    && ln -s /opt/platformio/bin/pio /usr/local/bin/pio \
    && ln -s /opt/platformio/bin/platformio /usr/local/bin/platformio

COPY helper.mjs /opt/agent-env/helper.mjs

RUN printf '%s\n' 'agent-env-runtime-v2' > /opt/agent-env/runtime-marker \
    && chown -R root:root /opt/agent-env \
    && chmod 0555 /opt/agent-env/helper.mjs \
    && chmod 0444 /opt/agent-env/runtime-marker

USER vscode
