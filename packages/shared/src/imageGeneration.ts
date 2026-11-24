// Image generation is an engine tool, including the same tool exposed by MCP.
export function isImageGeneration(name: string): boolean {
  return /(?:^|__|[./:])(?:image_generation|imageGeneration|generate_image|generate_images|image_gen|imagegen)$/i.test(name);
}

export const MAX_GENERATED_IMAGES = 8;
const encoder = new TextEncoder();

/** Whole local references only; an over-budget list is never truncated into bad paths. */
export function readGeneratedImagePaths(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_GENERATED_IMAGES) return undefined;
  let bytes = 0;
  for (const file of value) {
    if (typeof file !== "string" || !file.trim() || file.length > 4_096 || file.includes("\0") ||
        /^[\\/]{2}/.test(file.trim()) || (/^[a-z][a-z\d+.-]*:/i.test(file.trim()) && !/^[a-z]:[\\/]/i.test(file)) ||
        !/\.(?:png|jpe?g|gif|webp)$/i.test(file)) return undefined;
    const size = encoder.encode(file).byteLength;
    if (size > 4_096 || (bytes += size) > 8_192) return undefined;
  }
  return [...value];
}
