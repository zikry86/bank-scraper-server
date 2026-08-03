# Puppeteer base image ships a matching Chromium + fonts.
# israeli-bank-scrapers 6.8.0 depends on puppeteer ^24.40.0, so the image tag is
# pinned to the same Puppeteer line (24.40.0) to keep Chromium in sync.
# That image runs Node 24.14.0, which satisfies engines.node >= 22.22.2.
FROM ghcr.io/puppeteer/puppeteer:24.40.0


WORKDIR /app

# Run as the non-root 'pptruser' that the base image creates
USER root
COPY package.json package-lock.json* ./
RUN npm install --omit=dev && chown -R pptruser:pptruser /app
USER pptruser

COPY --chown=pptruser:pptruser src ./src

ENV NODE_ENV=production
ENV SCRAPER_PORT=3001
EXPOSE 3001

CMD ["node", "src/index.js"]
