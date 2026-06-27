FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PORT=8787 \
    LATEXDO_DATA_ROOT=/data/latexdo

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    dumb-init \
    latexmk \
    texlive-bibtex-extra \
    texlive-fonts-recommended \
    texlive-latex-base \
    texlive-latex-extra \
    texlive-latex-recommended \
    texlive-science \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install --ignore-scripts

COPY server ./server

RUN useradd --create-home --shell /usr/sbin/nologin latexdo \
  && mkdir -p /data/latexdo \
  && chown -R latexdo:latexdo /data/latexdo /app

USER latexdo
EXPOSE 8787

CMD ["dumb-init", "node", "--import", "tsx", "server/src/index.ts"]
