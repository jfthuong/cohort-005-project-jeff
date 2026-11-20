export function withUniqueSuffix(slug: string, taken: Set<string>): string {
  if (!taken.has(slug)) return slug;
  let n = 2;
  while (taken.has(`${slug}-${n}`)) n++;
  return `${slug}-${n}`;
}
