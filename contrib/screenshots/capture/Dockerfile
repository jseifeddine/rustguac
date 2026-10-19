# Seeds the demo data and takes the screenshots. The npm package must match
# the browsers baked into the Playwright image, so one version drives both.
ARG PLAYWRIGHT_VERSION=1.48.2
FROM mcr.microsoft.com/playwright:v${PLAYWRIGHT_VERSION}-noble
ARG PLAYWRIGHT_VERSION

# The UI asks for the generic `monospace` font. Without DejaVu Sans Mono,
# the most common Linux default, fontconfig picks a CJK font here.
RUN apt-get update \
    && apt-get install -y --no-install-recommends fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /capture
RUN npm install --no-audit --no-fund "playwright@${PLAYWRIGHT_VERSION}"
COPY *.mjs ./

CMD ["node", "capture.mjs"]
