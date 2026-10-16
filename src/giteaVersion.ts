import {getMilestones} from './github.ts';
import {releaseVersion, type Version} from './version.ts';

export class GiteaVersion {
  majorMinorVersion: string;
  version: Version;
  milestoneNumber: number;

  constructor(milestone: {number: number; version: Version}) {
    this.version = milestone.version;
    this.majorMinorVersion = releaseVersion(milestone.version);
    this.milestoneNumber = milestone.number;
  }
}

// returns all gitea versions from the gitea repository milestones
export async function fetchGiteaVersions(): Promise<GiteaVersion[]> {
  const milestones = await getMilestones();
  return milestones.map((milestone) => new GiteaVersion(milestone));
}
