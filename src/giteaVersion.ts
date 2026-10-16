import {SemVer} from 'semver';
import {getMilestones, releaseVersion} from './github.ts';

export class GiteaVersion {
  majorMinorVersion: string;
  semver: SemVer;
  milestoneNumber: number;

  constructor(milestone: {title: string; number: number}) {
    this.semver = new SemVer(milestone.title);
    this.majorMinorVersion = releaseVersion(this.semver);
    this.milestoneNumber = milestone.number;
  }
}

// returns all gitea versions from the gitea repository milestones
export async function fetchGiteaVersions(): Promise<GiteaVersion[]> {
  const milestones = await getMilestones();
  return milestones.map((milestone) => new GiteaVersion(milestone));
}
