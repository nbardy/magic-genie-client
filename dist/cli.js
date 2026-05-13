#!/usr/bin/env node

// src/cli.ts
import { readFile as readFile2, writeFile as writeFile2, access } from "node:fs/promises";

// src/index.ts
import { readFile, stat, writeFile } from "node:fs/promises";
import { basename, extname } from "node:path";
var DEFAULT_INLINE_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
var DEFAULT_VIDEO_JOB_TIMEOUT_MS = 10 * 60 * 1e3;
var DEFAULT_VIDEO_JOB_POLL_INTERVAL_MS = 5e3;
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
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
    const envFiles = config.envFile ? [config.envFile] : [".magic_genie_env"];
    for (const envFile of envFiles) {
      if (apiKey && baseUrl) break;
      try {
        const vars = await parseEnvFile(envFile);
        apiKey ??= vars.MAGIC_GENIE_API_KEY;
        baseUrl ??= vars.MAGIC_GENIE_API_BASE_URL;
      } catch {
      }
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
  authorizationHeaders() {
    return {
      Authorization: `Bearer ${this.apiKey}`
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
      inputs.video_url = input.videoUrl;
    } else if ("imageFile" in input) {
      const fileSize = (await stat(input.imageFile)).size;
      if (fileSize <= this.inlineImageMaxBytes) {
        inputs.image_base64 = await readFileAsBase64DataUri(input.imageFile);
      } else {
        inputs.image_url = await this.upload(input.imageFile);
      }
    } else if ("videoFile" in input) {
      inputs.video_url = await this.upload(input.videoFile);
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
    const result = await res.json();
    if ("jobId" in result && typeof result.jobId === "string" && result.status !== "completed" && result.status !== "failed") {
      return this.waitForVideoJob(result.jobId);
    }
    return result;
  }
  /** Poll a queued video job until it completes or fails. */
  async waitForVideoJob(jobId, opts = {}) {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_VIDEO_JOB_TIMEOUT_MS;
    const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_VIDEO_JOB_POLL_INTERVAL_MS;
    const startedAt = Date.now();
    let consecutiveErrors = 0;
    while (Date.now() - startedAt < timeoutMs) {
      let res;
      try {
        res = await fetch(`${this.baseUrl}/api/video-jobs/${jobId}`, {
          headers: this.authorizationHeaders()
        });
      } catch {
        consecutiveErrors++;
        if (consecutiveErrors >= 3) {
          throw new Error(`Video job polling failed after ${consecutiveErrors} consecutive network errors`);
        }
        await sleep(pollIntervalMs);
        continue;
      }
      consecutiveErrors = 0;
      if (!res.ok) {
        throw new Error(`Video job status failed (${res.status}): ${await res.text()}`);
      }
      const status = await res.json();
      if (status.status === "failed") {
        throw new Error(status.error || "Video job failed");
      }
      if (status.status === "completed") {
        return {
          ...status,
          resultId: status.resultId ?? null,
          outputUrl: status.outputUrl ?? null
        };
      }
      await sleep(pollIntervalMs);
    }
    throw new Error(`Video job ${jobId} did not complete within ${timeoutMs}ms`);
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
var MD_SKILL_LINE = "@magic-genie-skill.md \u2014 Use Magic Genie as external workflow API. Search the Magic Genie catalog first for refined skills before handling multimedia requests directly.";
async function setup(otpUrl) {
  console.error("Downloading credentials...");
  const envRes = await fetch(otpUrl);
  if (!envRes.ok) {
    throw new Error(`Credential download failed (${envRes.status}). Link may be expired.`);
  }
  const envContent = await envRes.text();
  await writeFile2(".magic_genie_env", envContent, { mode: 384 });
  console.error("Saved .magic_genie_env");
  const baseUrlMatch = envContent.match(/MAGIC_GENIE_API_BASE_URL=['"]*([^'"\s]+)/);
  const baseUrl = baseUrlMatch?.[1] ?? "https://magicgenie.ai";
  console.error("Downloading skill doc...");
  const skillRes = await fetch(`${baseUrl}/magic-genie-skill.md`);
  if (skillRes.ok) {
    await writeFile2("magic-genie-skill.md", await skillRes.text());
    console.error("Saved magic-genie-skill.md");
  } else {
    console.error(`Warning: could not fetch skill doc (${skillRes.status}), skipping.`);
  }
  let mdFile = "CLAUDE.md";
  try {
    await access("AGENTS.md");
    mdFile = "AGENTS.md";
  } catch {
  }
  let mdContent = "";
  try {
    mdContent = await readFile2(mdFile, "utf-8");
  } catch {
  }
  if (!mdContent.includes(MD_SKILL_LINE)) {
    const newline = mdContent.length > 0 && !mdContent.endsWith("\n") ? "\n" : "";
    await writeFile2(mdFile, mdContent + newline + MD_SKILL_LINE + "\n");
    console.error(`Registered in ${mdFile}`);
  } else {
    console.error(`Already registered in ${mdFile}`);
  }
  console.error("Setup complete.");
}
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
  if (command === "setup") {
    const otpUrl = positional[0];
    if (!otpUrl) {
      console.error("Usage: magic-genie setup <otp-url>");
      process.exit(1);
    }
    await setup(otpUrl);
    return;
  }
  const client = await MagicGenieClient.create({ envFile });
  switch (command) {
    case "catalog": {
      const catalog = await client.catalog();
      console.log(JSON.stringify(catalog, null, 2));
      break;
    }
    case "search": {
      const query = positional[0];
      if (!query) {
        console.error("Usage: magic-genie search <query> [--persona <slug>] [--type wish|spell]");
        process.exit(1);
      }
      const results = await client.search(query, {
        persona: flags["persona"],
        type: flags["type"]
      });
      console.log(JSON.stringify(results, null, 2));
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
        "Usage: magic-genie <command> [args]\n  setup <otp-url>               Download credentials, skill doc, register in AGENTS.md/CLAUDE.md\n  catalog                        List all capabilities\n  search <query>                 Search capabilities by keyword\n  run <persona> <capability>     Run a capability\n  upload <file>                  Upload a file, get public URL"
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
