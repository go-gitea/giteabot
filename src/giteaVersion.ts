import { parse, type SemVer } from "semver";
import { getMilestones } from "./github.ts";

// 1.x has a release branch per minor version, semver releases (28+) per major version
export const releaseVersion = ({ major, minor }: SemVer) =>
  major > 1 ? `${major}` : `${major}.${minor}`;

export class GiteaVersion {
  majorMinorVersion: string;
  semver: SemVer;
  milestoneNumber: number;

  constructor(milestone: { title: string; number: number }) {
    const semver = parse(milestone.title);
    if (!semver) {
      throw new Error(`Invalid milestone version: ${milestone.title}`);
    }
    this.semver = semver;
    this.majorMinorVersion = releaseVersion(this.semver);
    this.milestoneNumber = milestone.number;
  }
}

// returns all gitea versions from the gitea repository milestones
export const fetchGiteaVersions = async (): Promise<GiteaVersion[]> => {
  const milestones = await getMilestones();
  return milestones.map((milestone) => new GiteaVersion(milestone));
};
