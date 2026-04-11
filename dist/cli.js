#!/usr/bin/env node

// src/index.ts
import { readFile, stat, writeFile } from "node:fs/promises";
import { basename, extname } from "node:path";
var DEFAULT_INLINE_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
function mimeFromExt(filePath) {
  const ext = extname(filePath).toLowerCase();
  const mimeMap = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".mp4": "video/mp4",
    ".mov": "video/quicktime",
    ".webm": "video/webm",
    ".avi": "video/x-msvideo",
    ".mkv": "video/x-matroska"
  };
  return mimeMap[ext] ?? "application/octet-stream";
}
function isVideoMime(mime) {
  return mime.startsWith("video/");
}
async function readFileAsBase64DataUri(filePath) {
  const buf = await readFile(filePath);
  const mime = mimeFromExt(filePath);
  return `data:${mime};base64,${buf.toString("base64")}`;
}
async function parseEnvFile(filePath) {
  const text = await readFile(filePath, "utf-8");
  const vars = {};
  for (const line of text.split("\n")) {
    let trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (trimmed.startsWith("export ")) trimmed = trimmed.slice(7);
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    if (value.startsWith("'") && value.endsWith("'") || value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }
    vars[key] = value;
  }
  return vars;
}
var MagicGenieClient = class _MagicGenieClient {
  apiKey;
  baseUrl;
  inlineImageMaxBytes;
  constructor(apiKey, baseUrl, inlineImageMaxBytes) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.inlineImageMaxBytes = inlineImageMaxBytes;
  }
  /**
   * Create a client. Resolves credentials in order:
   * 1. Explicit `apiKey` / `baseUrl` in config
   * 2. `envFile` path (parsed for MAGIC_GENIE_API_KEY / MAGIC_GENIE_API_BASE_URL)
   * 3. Process env vars
   */
  static async create(config = {}) {
    let apiKey = config.apiKey;
    let baseUrl = config.baseUrl;
    if (config.envFile && (!apiKey || !baseUrl)) {
      const vars = await parseEnvFile(config.envFile);
      apiKey ??= vars.MAGIC_GENIE_API_KEY;
      baseUrl ??= vars.MAGIC_GENIE_API_BASE_URL;
    }
    apiKey ??= process.env.MAGIC_GENIE_API_KEY;
    baseUrl ??= process.env.MAGIC_GENIE_API_BASE_URL ?? "https://magicgenie.ai";
    if (!apiKey) {
      throw new Error(
        "No API key found. Pass apiKey, set envFile, or export MAGIC_GENIE_API_KEY."
      );
    }
    return new _MagicGenieClient(
      apiKey,
      baseUrl,
      config.inlineImageMaxBytes ?? DEFAULT_INLINE_IMAGE_MAX_BYTES
    );
  }
  authHeaders() {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json"
    };
  }
  // ── Catalog ──
  /** Fetch the full capability catalog. */
  async catalog() {
    const res = await fetch(`${this.baseUrl}/v1/catalog`, {
      headers: this.authHeaders()
    });
    if (!res.ok) {
      throw new Error(`Catalog fetch failed (${res.status}): ${await res.text()}`);
    }
    return res.json();
  }
  // ── Asset Upload ──
  /**
   * Request a signed upload URL, then PUT the file bytes to it.
   * Returns the publicUrl to use in subsequent /v1/run calls.
   */
  async upload(filePath) {
    const filename = basename(filePath);
    const contentType = mimeFromExt(filePath);
    const mediaType = isVideoMime(contentType) ? "video" : "image";
    const targetRes = await fetch(`${this.baseUrl}/v1/assets`, {
      method: "POST",
      headers: this.authHeaders(),
      body: JSON.stringify({ filename, contentType, mediaType })
    });
    if (!targetRes.ok) {
      throw new Error(
        `Asset upload target failed (${targetRes.status}): ${await targetRes.text()}`
      );
    }
    const target = await targetRes.json();
    const fileBytes = await readFile(filePath);
    const putRes = await fetch(target.uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": contentType },
      body: fileBytes
    });
    if (!putRes.ok) {
      throw new Error(`Asset upload PUT failed (${putRes.status})`);
    }
    return target.publicUrl;
  }
  // ── Run ──
  /**
   * Run a capability. Handles image/video input automatically:
   * - imageUrl / videoUrl: passed through as-is
   * - imageFile: base64 inline if small enough, signed URL upload otherwise
   * - videoFile: always signed URL upload
   */
  async run(input) {
    const body = {
      personaSlug: input.personaSlug,
      capabilitySlug: input.capabilitySlug,
      inputs: {
        prompt: input.prompt ?? "",
        visibility: input.visibility ?? "public",
        targetNodeIds: input.targetNodeIds
      }
    };
    if (input.capabilityType) body.capabilityType = input.capabilityType;
    if (input.variantSlug) body.variantSlug = input.variantSlug;
    const inputs = body.inputs;
    if ("imageUrl" in input) {
      inputs.image_url = input.imageUrl;
    } else if ("videoUrl" in input) {
      inputs.image_url = input.videoUrl;
    } else if ("imageFile" in input) {
      const fileSize = (await stat(input.imageFile)).size;
      if (fileSize <= this.inlineImageMaxBytes) {
        inputs.image_base64 = await readFileAsBase64DataUri(input.imageFile);
      } else {
        inputs.image_url = await this.upload(input.imageFile);
      }
    } else if ("videoFile" in input) {
      inputs.image_url = await this.upload(input.videoFile);
    }
    const res = await fetch(`${this.baseUrl}/v1/run`, {
      method: "POST",
      headers: this.authHeaders(),
      body: JSON.stringify(body)
    });
    if (res.status === 402) {
      const errorBody = await res.json();
      throw new CreditError(errorBody);
    }
    if (!res.ok) {
      throw new Error(`Run failed (${res.status}): ${await res.text()}`);
    }
    return res.json();
  }
  // ── Download ──
  /** Download a result asset to a local file path. */
  async download(outputUrl, destPath) {
    const res = await fetch(outputUrl);
    if (!res.ok) {
      throw new Error(`Download failed (${res.status})`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    await writeFile(destPath, buf);
  }
};
var CreditError = class extends Error {
  body;
  constructor(body) {
    super("Insufficient credits (402). Check .body for buy_credits links.");
    this.name = "CreditError";
    this.body = body;
  }
};

// src/cli.ts
function parseArgs(argv) {
  const args = argv.slice(2);
  const command = args[0] ?? "";
  const positional = [];
  const flags = {};
  let i = 1;
  while (i < args.length) {
    if (args[i].startsWith("--")) {
      const key = args[i].slice(2);
      const value = args[i + 1] ?? "";
      flags[key] = value;
      i += 2;
    } else {
      positional.push(args[i]);
      i++;
    }
  }
  return { command, positional, flags };
}
async function main() {
  const { command, positional, flags } = parseArgs(process.argv);
  const envFile = flags["env-file"] ?? void 0;
  const client = await MagicGenieClient.create({ envFile });
  switch (command) {
    case "catalog": {
      const catalog = await client.catalog();
      console.log(JSON.stringify(catalog, null, 2));
      break;
    }
    case "upload": {
      const filePath = positional[0];
      if (!filePath) {
        console.error("Usage: magic-genie upload <file>");
        process.exit(1);
      }
      const publicUrl = await client.upload(filePath);
      console.log(JSON.stringify({ publicUrl }));
      break;
    }
    case "run": {
      const personaSlug = positional[0];
      const capabilitySlug = positional[1];
      if (!personaSlug || !capabilitySlug) {
        console.error("Usage: magic-genie run <persona> <capability> [options]");
        process.exit(1);
      }
      const input = {
        personaSlug,
        capabilitySlug
      };
      if (flags["type"]) input.capabilityType = flags["type"];
      if (flags["prompt"]) input.prompt = flags["prompt"];
      if (flags["visibility"]) input.visibility = flags["visibility"];
      if (flags["image-url"]) input.imageUrl = flags["image-url"];
      if (flags["image-file"]) input.imageFile = flags["image-file"];
      if (flags["video-url"]) input.videoUrl = flags["video-url"];
      if (flags["video-file"]) input.videoFile = flags["video-file"];
      const result = await client.run(input);
      console.log(JSON.stringify(result, null, 2));
      if (flags["download"] && result.outputUrl) {
        await client.download(result.outputUrl, flags["download"]);
        console.error(`Downloaded to ${flags["download"]}`);
      }
      break;
    }
    default: {
      console.error(
        "Usage: magic-genie <catalog|run|upload> [args]\n  catalog                        List all capabilities\n  run <persona> <capability>     Run a capability\n  upload <file>                  Upload a file, get public URL"
      );
      process.exit(1);
    }
  }
}
main().catch((err) => {
  console.error(JSON.stringify({ error: err.message }));
  process.exit(1);
});
//# sourceMappingURL=cli.js.map
