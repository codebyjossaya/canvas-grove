export function classifyManagedContainer({ name, createdAt, registryNames, ownedSessionIds, now = Date.now(), graceMs }) {
  if (registryNames.has(name)) return "protected";
  const ownedNames = new Set(ownedSessionIds.map((id) => `canvas-browser-${id}`));
  if (ownedNames.has(name)) return "protected";
  const created = Date.parse(createdAt);
  if (!Number.isFinite(created) || now - created < graceMs) return "quarantined";
  return "remove";
}
