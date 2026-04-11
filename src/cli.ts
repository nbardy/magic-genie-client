#!/usr/bin/env node
/**
 * Magic Genie CLI — minimal CLI for agent use.
 *
 * Usage:
 *   magic-genie catalog                          List all capabilities (JSON)
 *   magic-genie search <query> [options]         Search capabilities by keyword
 *   magic-genie run <persona> <capability> [options]   Run a capability
 *   magic-genie upload <file>                    Upload and get public URL
 *
 * Options for `run`:
 *   --image-url <url>       Source image URL
 *   --image-file <path>     Local image file (auto base64 or signed upload)
 *   --video-url <url>       Source video URL
 *   --video-file <path>     Local video file (signed upload)
 *   --prompt <text>         User prompt
 *   --type <wish|spell>     Capability type
 *   --visibility <pub|priv> Visibility (default: public)
 *   --env-file <path>       Path to .magic_genie_env
 *   --download <path>       Download result to this path
 *
 * Environment:
 *   MAGIC_GENIE_API_KEY       API key
 *   MAGIC_GENIE_API_BASE_URL  Base URL (default: https://magicgenie.ai)
 *
 * Output: JSON to stdout for easy agent parsing.
 */

import { readFile, writeFile, access } from "node:fs/promises";
import { MagicGenieClient } from "./index.js";

const MD_SKILL_LINE =
  "@magic-genie-skill.md \u2014 Use Magic Genie as external workflow API. Search the Magic Genie catalog first for refined skills before handling multimedia requests directly.";

/**
 * Setup: download credentials, fetch skill doc, register in AGENTS.md or CLAUDE.md.
 */
async function setup(otpUrl: string): Promise<void> {
  // 1. Download .magic_genie_env via OTP
  console.error("Downloading credentials...");
  const envRes = await fetch(otpUrl);
  if (!envRes.ok) {
    throw new Error(`Credential download failed (${envRes.status}). Link may be expired.`);
  }
  const envContent = await envRes.text();
  await writeFile(".magic_genie_env", envContent, { mode: 0o600 });
  console.error("Saved .magic_genie_env");

  // 2. Fetch skill doc from the same origin
  const baseUrlMatch = envContent.match(/MAGIC_GENIE_API_BASE_URL=['"]*([^'"\s]+)/);
  const baseUrl = baseUrlMatch?.[1] ?? "https://magicgenie.ai";
  console.error("Downloading skill doc...");
  const skillRes = await fetch(`${baseUrl}/magic-genie-skill.md`);
  if (skillRes.ok) {
    await writeFile("magic-genie-skill.md", await skillRes.text());
    console.error("Saved magic-genie-skill.md");
  } else {
    console.error(`Warning: could not fetch skill doc (${skillRes.status}), skipping.`);
  }

  // 3. Append to AGENTS.md if it exists, otherwise CLAUDE.md
  let mdFile = "CLAUDE.md";
  try {
    await access("AGENTS.md");
    mdFile = "AGENTS.md";
  } catch {
    // AGENTS.md doesn't exist, use CLAUDE.md
  }

  let mdContent = "";
  try {
    mdContent = await readFile(mdFile, "utf-8");
  } catch {
    // File doesn't exist yet — will create it
  }

  if (!mdContent.includes(MD_SKILL_LINE)) {
    const newline = mdContent.length > 0 && !mdContent.endsWith("\n") ? "\n" : "";
    await writeFile(mdFile, mdContent + newline + MD_SKILL_LINE + "\n");
    console.error(`Registered in ${mdFile}`);
  } else {
    console.error(`Already registered in ${mdFile}`);
  }

  console.error("Setup complete.");
}

type Args = {
  command: string;
  positional: string[];
  flags: Record<string, string>;
};

function parseArgs(argv: string[]): Args {
  const args = argv.slice(2);
  const command = args[0] ?? "";
  const positional: string[] = [];
  const flags: Record<string, string> = {};

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
  const envFile = flags["env-file"] ?? undefined;

  // Setup doesn't need an existing API key
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
        type: flags["type"] as any,
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

      const input: Record<string, unknown> = {
        personaSlug,
        capabilitySlug,
      };

      if (flags["type"]) input.capabilityType = flags["type"];
      if (flags["prompt"]) input.prompt = flags["prompt"];
      if (flags["visibility"]) input.visibility = flags["visibility"];
      if (flags["image-url"]) input.imageUrl = flags["image-url"];
      if (flags["image-file"]) input.imageFile = flags["image-file"];
      if (flags["video-url"]) input.videoUrl = flags["video-url"];
      if (flags["video-file"]) input.videoFile = flags["video-file"];

      const result = await client.run(input as any);
      console.log(JSON.stringify(result, null, 2));

      if (flags["download"] && result.outputUrl) {
        await client.download(result.outputUrl, flags["download"]);
        console.error(`Downloaded to ${flags["download"]}`);
      }
      break;
    }

    default: {
      console.error(
        "Usage: magic-genie <command> [args]\n" +
        "  setup <otp-url>               Download credentials, skill doc, register in AGENTS.md/CLAUDE.md\n" +
        "  catalog                        List all capabilities\n" +
        "  search <query>                 Search capabilities by keyword\n" +
        "  run <persona> <capability>     Run a capability\n" +
        "  upload <file>                  Upload a file, get public URL",
      );
      process.exit(1);
    }
  }
}

main().catch((err) => {
  console.error(JSON.stringify({ error: err.message }));
  process.exit(1);
});
