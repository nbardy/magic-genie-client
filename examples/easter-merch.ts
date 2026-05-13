/**
 * Example: Generate Easter merch for Magic Genie using a local logo file.
 *
 * Usage:
 *   bun run examples/easter-merch.ts
 */
import { MagicGenieClient } from "../src/index";

const client = await MagicGenieClient.create({
  envFile: "../../.magic_genie_env",
});

const result = await client.run({
  personaSlug: "merch-seller",
  capabilitySlug: "product-photo-studio",
  capabilityType: "spell",
  imageFile: "../../app/icon.png",
  prompt:
    "Easter collection hoodie mockup. Magic Genie brand — use the logo. Pastel spring colors, bunny ears on the genie, Easter eggs in the smoke trail. Show 4 colorways: cream, navy, sage green, lavender.",
});

console.log("Result:", result);
console.log("Output:", result.outputUrl);

if (!result.outputUrl) {
  throw new Error("Run completed without an output URL.");
}

await client.download(result.outputUrl, "easter-merch-output.jpg");
console.log("Saved to easter-merch-output.jpg");
