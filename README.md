# magic-genie-client

Thin Node.js / Bun client for the [Magic Genie](https://magicgenie.ai) API.

Handles auth, local file uploads (base64 for images, signed URLs for videos), catalog discovery, and result downloading. Zero runtime dependencies.

## Install

```bash
npm install magic-genie-client
```

## Quick Start

```ts
import { MagicGenieClient } from "magic-genie-client";

const client = await MagicGenieClient.create({
  envFile: ".magic_genie_env", // or pass apiKey directly
});

// Run with a local image (auto base64 encoded)
const result = await client.run({
  personaSlug: "merch-seller",
  capabilitySlug: "merch-drop-hoodie",
  capabilityType: "wish",
  imageFile: "./logo.png",
  prompt: "Easter collection hoodie, pastel colors",
});

console.log(result.outputUrl);

// Download the result
await client.download(result.outputUrl, "output.jpg");
```

## Image vs Video Handling

| Input | Method | Why |
|---|---|---|
| `imageFile` (< 10MB) | Base64 inline | Fast, single request |
| `imageFile` (> 10MB) | Signed URL upload | Avoids payload bloat |
| `videoFile` | Signed URL upload | Videos are always large |
| `imageUrl` / `videoUrl` | Pass-through | Already hosted |

## CLI

```bash
# List capabilities
magic-genie catalog --env-file .magic_genie_env

# Run a capability
magic-genie run merch-seller merch-drop-hoodie \
  --type wish \
  --image-file ./logo.png \
  --prompt "Easter hoodie" \
  --download output.jpg

# Upload a file (get public URL)
magic-genie upload ./video.mp4 --env-file .magic_genie_env
```

## Auth

Credentials are resolved in order:
1. `apiKey` / `baseUrl` passed to `MagicGenieClient.create()`
2. Parsed from `envFile` (shell-style `export KEY='value'`)
3. `MAGIC_GENIE_API_KEY` / `MAGIC_GENIE_API_BASE_URL` env vars

## Build

```bash
npm install
node build.mjs   # outputs dist/index.js + dist/cli.js
```

Targets Node 20+. Single-file ESM bundles, zero dependencies at runtime.
