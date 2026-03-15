/** Brief member entry for members.json */
export interface MemberEntry {
  name: string;
  title: string;
  roles: string[];
  /** Sequence number within role category (lower runs first) */
  sequenceOrder: number;
  active: boolean;
  type: 'human' | 'ai';
}

/** Root members.json structure */
export interface MembersManifest {
  members: MemberEntry[];
}
