/**
 * Magic Genie Client
 *
 * Thin Node 20 / Bun client for the Magic Genie API.
 * Handles: auth, local-file uploads (base64 for images, signed URLs for videos),
 * catalog discovery, and result downloading.
 *
 * Zero runtime dependencies — uses Node 20 built-ins (fs, buffer, fetch).
 */

import { readFile, stat, writeFile } from "node:fs/promises";
import { basename, extname } from "node:path";

// ── Types ──────────────────────────────────────────────────────────────

export type CapabilityType = "wish" | "spell";
export type Visibility = "public" | "private";
export type MediaType = "image" | "video";

export type CatalogEntry = {
  slug: string;
  title: string;
  description: string;
  execution_type: CapabilityType;
  capability_type: CapabilityType;
  credit_cost: number;
  persona_slug: string;
  canonical_path: string;
  operator_slug: string;
  route: string;
  billing_mode: string;
  estimated_duration_seconds: number;
  input_contract: Record<string, unknown>;
  output_contract: Record<string, unknown>;
};

export type Catalog = {
  capabilities: CatalogEntry[];
  count: number;
};

export type RunInput = {
  personaSlug: string;
  capabilitySlug: string;
  capabilityType?: CapabilityType;
  variantSlug?: string;
  prompt?: string;
  visibility?: Visibility;
  targetNodeIds?: string[];
} & (
  | { imageUrl: string }
  | { imageFile: string }
  | { videoUrl: string }
  | { videoFile: string }
);

export type RunResult = {
  resultId: string | null;
  outputUrl: string | null;
  [key: string]: unknown;
};

export type VideoJobStatus = {
  jobId: string;
  status: "queued" | "processing" | "completed" | "failed";
  stage?: string;
  progress?: number;
  detail?: string;
  resultId?: string | null;
  outputUrl?: string | null;
  error?: string | null;
  [key: string]: unknown;
};

export type AssetUploadResult = {
  uploadUrl: string;
  publicUrl: string;
  expiresInSeconds: number;
};

export type ClientConfig = {
  /** API key (mg_...). Falls back to MAGIC_GENIE_API_KEY env var. */
  apiKey?: string;
  /** Base URL. Falls back to MAGIC_GENIE_API_BASE_URL or https://magicgenie.ai */
  baseUrl?: string;
  /** Path to .magic_genie_env file to load credentials from. */
  envFile?: string;
  /**
   * Max image size in bytes before switching from inline base64 to signed URL upload.
   * Default: 10MB. Images under this threshold go inline; above use signed URLs.
   */
  inlineImageMaxBytes?: number;
};

// ── Helpers ────────────────────────────────────────────────────────────

const DEFAULT_INLINE_IMAGE_MAX_BYTES = 10 * 1024 * 1024; // 10MB
const DEFAULT_VIDEO_JOB_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_VIDEO_JOB_POLL_INTERVAL_MS = 5000;

function mimeFromExt(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  const mimeMap: Record<string, string> = {
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
    ".mkv": "video/x-matroska",
  };
  return mimeMap[ext] ?? "application/octet-stream";
}

function isVideoMime(mime: string): boolean {
  return mime.startsWith("video/");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readFileAsBase64DataUri(filePath: string): Promise<string> {
  const buf = await readFile(filePath);
  const mime = mimeFromExt(filePath);
  return `data:${mime};base64,${buf.toString("base64")}`;
}

/**
 * Parse a shell-style env file (supports `export KEY='value'` and `KEY=value`).
 */
async function parseEnvFile(filePath: string): Promise<Record<string, string>> {
  const text = await readFile(filePath, "utf-8");
  const vars: Record<string, string> = {};
  for (const line of text.split("\n")) {
    let trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (trimmed.startsWith("export ")) trimmed = trimmed.slice(7);
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    if (
      (value.startsWith("'") && value.endsWith("'")) ||
      (value.startsWith('"') && value.endsWith('"'))
    ) {
      value = value.slice(1, -1);
    }
    vars[key] = value;
  }
  return vars;
}

// ── Client ─────────────────────────────────────────────────────────────

export class MagicGenieClient {
  private apiKey: string;
  private baseUrl: string;
  private inlineImageMaxBytes: number;

  private constructor(apiKey: string, baseUrl: string, inlineImageMaxBytes: number) {
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
  static async create(config: ClientConfig = {}): Promise<MagicGenieClient> {
    let apiKey = config.apiKey;
    let baseUrl = config.baseUrl;

    // Try explicit envFile first, then default .magic_genie_env in cwd
    const envFiles = config.envFile
      ? [config.envFile]
      : [".magic_genie_env"];

    for (const envFile of envFiles) {
      if (apiKey && baseUrl) break;
      try {
        const vars = await parseEnvFile(envFile);
        apiKey ??= vars.MAGIC_GENIE_API_KEY;
        baseUrl ??= vars.MAGIC_GENIE_API_BASE_URL;
      } catch {
        // File doesn't exist — continue to next source
      }
    }

    apiKey ??= process.env.MAGIC_GENIE_API_KEY;
    baseUrl ??= process.env.MAGIC_GENIE_API_BASE_URL ?? "https://magicgenie.ai";

    if (!apiKey) {
      throw new Error(
        "No API key found. Pass apiKey, set envFile, or export MAGIC_GENIE_API_KEY.",
      );
    }

    return new MagicGenieClient(
      apiKey,
      baseUrl,
      config.inlineImageMaxBytes ?? DEFAULT_INLINE_IMAGE_MAX_BYTES,
    );
  }

  private authHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
    };
  }

  private authorizationHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
    };
  }

  // ── Catalog & Search ──

  /** Fetch the full capability catalog. */
  async catalog(): Promise<Catalog> {
    const res = await fetch(`${this.baseUrl}/v1/catalog`, {
      headers: this.authHeaders(),
    });
    if (!res.ok) {
      throw new Error(`Catalog fetch failed (${res.status}): ${await res.text()}`);
    }
    return res.json() as Promise<Catalog>;
  }

  /**
   * Search the catalog by keyword. Matches against slug, title, description,
   * persona_slug, and operator_slug. Case-insensitive.
   * Optionally filter by persona and/or capability type.
   */
  async search(query: string, opts?: {
    persona?: string;
    type?: CapabilityType;
  }): Promise<CatalogEntry[]> {
    const catalog = await this.catalog();
    const q = query.toLowerCase();

    return catalog.capabilities.filter((entry) => {
      if (opts?.persona && entry.persona_slug !== opts.persona) return false;
      if (opts?.type && entry.capability_type !== opts.type) return false;

      return (
        entry.slug.includes(q) ||
        entry.title.toLowerCase().includes(q) ||
        entry.description.toLowerCase().includes(q) ||
        entry.persona_slug.includes(q) ||
        entry.operator_slug.includes(q)
      );
    });
  }

  // ── Asset Upload ──

  /**
   * Request a signed upload URL, then PUT the file bytes to it.
   * Returns the publicUrl to use in subsequent /v1/run calls.
   */
  async upload(filePath: string): Promise<string> {
    const filename = basename(filePath);
    const contentType = mimeFromExt(filePath);
    const mediaType: MediaType = isVideoMime(contentType) ? "video" : "image";

    // 1. Get signed URL
    const targetRes = await fetch(`${this.baseUrl}/v1/assets`, {
      method: "POST",
      headers: this.authHeaders(),
      body: JSON.stringify({ filename, contentType, mediaType }),
    });

    if (!targetRes.ok) {
      throw new Error(
        `Asset upload target failed (${targetRes.status}): ${await targetRes.text()}`,
      );
    }

    const target = (await targetRes.json()) as AssetUploadResult;

    // 2. PUT bytes directly to R2
    const fileBytes = await readFile(filePath);
    const putRes = await fetch(target.uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": contentType },
      body: fileBytes,
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
  async run(input: RunInput): Promise<RunResult> {
    const body: Record<string, unknown> = {
      personaSlug: input.personaSlug,
      capabilitySlug: input.capabilitySlug,
      inputs: {
        prompt: input.prompt ?? "",
        visibility: input.visibility ?? "public",
        targetNodeIds: input.targetNodeIds,
      },
    };

    if (input.capabilityType) body.capabilityType = input.capabilityType;
    if (input.variantSlug) body.variantSlug = input.variantSlug;

    const inputs = body.inputs as Record<string, unknown>;

    if ("imageUrl" in input) {
      inputs.image_url = input.imageUrl;
    } else if ("videoUrl" in input) {
      inputs.video_url = input.videoUrl;
    } else if ("imageFile" in input) {
      const fileSize = (await stat(input.imageFile)).size;
      if (fileSize <= this.inlineImageMaxBytes) {
        // Small image — inline as base64
        inputs.image_base64 = await readFileAsBase64DataUri(input.imageFile);
      } else {
        // Large image — upload via signed URL first
        inputs.image_url = await this.upload(input.imageFile);
      }
    } else if ("videoFile" in input) {
      // Videos always go through signed URL upload
      inputs.video_url = await this.upload(input.videoFile);
    }

    const res = await fetch(`${this.baseUrl}/v1/run`, {
      method: "POST",
      headers: this.authHeaders(),
      body: JSON.stringify(body),
    });

    if (res.status === 402) {
      const errorBody = await res.json();
      throw new CreditError(errorBody);
    }

    if (!res.ok) {
      throw new Error(`Run failed (${res.status}): ${await res.text()}`);
    }

    const result = (await res.json()) as RunResult | VideoJobStatus;
    if (
      "jobId" in result &&
      typeof result.jobId === "string" &&
      result.status !== "completed" &&
      result.status !== "failed"
    ) {
      return this.waitForVideoJob(result.jobId);
    }

    return result as RunResult;
  }

  /** Poll a queued video job until it completes or fails. */
  async waitForVideoJob(
    jobId: string,
    opts: {
      timeoutMs?: number;
      pollIntervalMs?: number;
    } = {},
  ): Promise<RunResult> {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_VIDEO_JOB_TIMEOUT_MS;
    const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_VIDEO_JOB_POLL_INTERVAL_MS;
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
      const res = await fetch(`${this.baseUrl}/api/video-jobs/${jobId}`, {
        headers: this.authorizationHeaders(),
      });

      if (!res.ok) {
        throw new Error(`Video job status failed (${res.status}): ${await res.text()}`);
      }

      const status = (await res.json()) as VideoJobStatus;
      if (status.status === "failed") {
        throw new Error(status.error || "Video job failed");
      }
      if (status.status === "completed") {
        return {
          ...status,
          resultId: status.resultId ?? null,
          outputUrl: status.outputUrl ?? null,
        };
      }

      await sleep(pollIntervalMs);
    }

    throw new Error(`Video job ${jobId} did not complete within ${timeoutMs}ms`);
  }

  // ── Download ──

  /** Download a result asset to a local file path. */
  async download(outputUrl: string, destPath: string): Promise<void> {
    const res = await fetch(outputUrl);
    if (!res.ok) {
      throw new Error(`Download failed (${res.status})`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    await writeFile(destPath, buf);
  }
}

/** Thrown on HTTP 402 — contains buy_credits links for programmatic top-up. */
export class CreditError extends Error {
  body: unknown;
  constructor(body: unknown) {
    super("Insufficient credits (402). Check .body for buy_credits links.");
    this.name = "CreditError";
    this.body = body;
  }
}
