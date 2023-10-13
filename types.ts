export type UserConfig = Partial<{
  harvestUserId: number;
  harvestAccessToken: string;
  harvestAccountId: number;
}>;

export type ProjectConfig = Partial<{
  harvestId: number;
  jiraProjectKey: string;
  atlassianDomain: string;

  atlassianApiToken: string;
  atlassianAccountEmail: string;
}>;

export interface Config {
  user: UserConfig;
  projects?: Array<ProjectConfig>;
}

export interface HarvestTimeEntriesPage {
  next_page: number | null;
  time_entries: Array<HarvestTimeEntry>;
}

export interface HarvestTimeEntry {
  id: number;
  is_closed: boolean;
  notes?: string;
  project: {
    id: number;
    name: string;
  };
  rounded_hours: number;
  spent_date: string;
  user: {
    id: number;
    name: string;
  };
}

export interface JiraUser {
  timeZone: string;
}

export type TextContent = {
  type: "text";
  text: string;
};
export type EmojiContent = {
  type: "emoji";
  attrs: {
    shortName: string;
    id: string;
  };
};
// this API resource may actually be less sparse than
// the interface suggests, but Jira REST can be unreliable
export type JiraWorkLog = Partial<{
  timeSpentSeconds: number;
  notifyUsers: boolean;
  started: string;
  comment: Partial<{
    version: 1;
    type: "doc";
    content: Array<
      Partial<{
        type: "paragraph";
        content: Array<Partial<TextContent> | Partial<EmojiContent>>;
      }>
    >;
  }>;
}>;

export interface JiraIssue {
  key: string;
  fields: Partial<{
    worklog: Partial<{
      worklogs: Array<JiraWorkLog>;
    }>;
  }>;
}

export interface BaseIterable {
  timeEntry: HarvestTimeEntry;
}

export type WithFullConfig = BaseIterable & {
  config: Config;
};

export type ProjectConfigEnrichment = { projectConfig: ProjectConfig };
export type WithProjectConfig = WithFullConfig &
  Partial<ProjectConfigEnrichment>;
export type DefinitelyWithProjectConfig = WithFullConfig &
  ProjectConfigEnrichment;

export type UserTzEnrichment = { userTz: string };
export type DefinitelyWithUserTz = DefinitelyWithProjectConfig &
  UserTzEnrichment;

export type JiraIssueEnrichment = { jiraIssue: JiraIssue };
export type WithJiraIssue = DefinitelyWithUserTz & Partial<JiraIssueEnrichment>;
export type DefinitelyWithJiraIssue = DefinitelyWithUserTz &
  JiraIssueEnrichment;
