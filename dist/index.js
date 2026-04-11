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
  // ── Catalog & Search ──
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
  /**
   * Search the catalog by keyword. Matches against slug, title, description,
   * persona_slug, and operator_slug. Case-insensitive.
   * Optionally filter by persona and/or capability type.
   */
  async search(query, opts) {
    const catalog = await this.catalog();
    const q = query.toLowerCase();
    return catalog.capabilities.filter((entry) => {
      if (opts?.persona && entry.persona_slug !== opts.persona) return false;
      if (opts?.type && entry.capability_type !== opts.type) return false;
      return entry.slug.includes(q) || entry.title.toLowerCase().includes(q) || entry.description.toLowerCase().includes(q) || entry.persona_slug.includes(q) || entry.operator_slug.includes(q);
    });
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
export {
  CreditError,
  MagicGenieClient
};
//# sourceMappingURL=index.js.map
