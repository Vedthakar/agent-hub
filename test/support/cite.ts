/** Line ids of transcript lines in a router prompt whose text contains `needle`, as a model citing evidence would. */
export function cite(prompt: string, needle: string): string[] {
  return [...prompt.matchAll(/^\[(m\d+) [^\]]+\] [^:\n]+: (.*)$/gm)].filter((m) => m[2].includes(needle)).map((m) => m[1]);
}
