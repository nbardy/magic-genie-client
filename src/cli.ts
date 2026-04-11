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

import { MagicGenieClient } from "./index.js";

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
        "Usage: magic-genie <catalog|search|run|upload> [args]\n" +
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
