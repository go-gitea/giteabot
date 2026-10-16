export type Version = {major: number; minor: number; patch: number};

export function parseVersion(title: string): Version | null {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(title);
  if (!match) return null;
  const [major, minor, patch] = match.slice(1).map(Number);
  return {major, minor, patch};
}

export const compareVersions = (a: Version, b: Version) => a.major - b.major || a.minor - b.minor || a.patch - b.patch;

// 1.x has a release branch per minor version, semver releases (28+) per major version
export const releaseVersion = ({major, minor}: Version) => major > 1 ? String(major) : `${major}.${minor}`;
