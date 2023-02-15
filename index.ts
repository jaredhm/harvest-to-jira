import "@js-joda/timezone"; // required to use ZoneId
import { promises as fs, constants } from "fs";
import {
  LocalDate,
  ZonedDateTime,
  LocalTime,
  ZoneId,
  TemporalAdjusters,
  DayOfWeek,
  convert,
  DateTimeFormatter,
  LocalDateTime,
} from "@js-joda/core";
import path from "path";
import fetch from "node-fetch";
import prompts from "prompts";
import assert from "assert";

const CONFIG_DIR = "config";
const HARVEST_API_BASE_URL = "https://api.harvestapp.com";
const HARVEST_LOG_STRING = "~~~ LOGGED TO JIRA ~~~";

type UserConfig = Partial<{
  harvestUserId: number;
  harvestAccessToken: string;
  harvestAccountId: number;
}>;

type ProjectConfig = Partial<{
  harvestId: number;
  jiraProjectKey: string;
  atlassianDomain: string;
  atlassianApiToken: string;
  atlassianAccountEmail: string;
}>;

interface Config {
  user: UserConfig;
  projects?: Array<ProjectConfig>;
}

interface HarvestTimeEntriesPage {
  next_page: number | null;
  time_entries: Array<HarvestTimeEntry>;
}

interface HarvestTimeEntry {
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

interface JiraUser {
  timeZone: string;
}

// this API resource may actually be less sparse than
// the interface suggests, but Jira REST can be unreliable
type JiraWorkLog = Partial<{
  comment: Partial<{
    type: "doc";
    content: Array<
      Partial<{
        type: "paragraph";
        content: Array<
          Partial<{
            type: "text";
            text: string;
          }>
        >;
      }>
    >;
  }>;
}>;

interface JiraIssue {
  key: string;
  fields: Partial<{
    worklog: Partial<{
      worklogs: Array<JiraWorkLog>;
    }>;
  }>;
}

const getHarvestHeaders = (config: Config) => {
  assert(config.user.harvestAccessToken);
  assert(config.user.harvestAccountId);

  return {
    "User-Agent": "Node.js API Client",
    Authorization: `Bearer ${config.user.harvestAccessToken}`,
    "Harvest-Account-ID": config.user.harvestAccountId.toString(),
    "Content-Type": "application/json",
  };
};

const getJiraHeaders = (projectConfig: ProjectConfig) => {
  assert(projectConfig.atlassianAccountEmail);
  assert(projectConfig.atlassianApiToken);

  return {
    Authorization: `Basic ${Buffer.from(
      projectConfig.atlassianAccountEmail +
        ":" +
        projectConfig.atlassianApiToken
    ).toString("base64")}`,
    Accept: "application/json",
  };
};

const getHarvestTimeEntries = async (
  timeFloor: LocalDateTime,
  timeCeiling: LocalDateTime,
  config: Config
): Promise<Array<HarvestTimeEntry>> => {
  let timeEntries = new Array<HarvestTimeEntry>();

  let requestMore = false;
  let page = 1;

  do {
    const url = new URL("/v2/time_entries", HARVEST_API_BASE_URL);
    const params = {
      page,
      per_page: 100,
      from: timeFloor.toString(),
      to: timeCeiling.toString(),
    };
    Object.entries(params).forEach(([key, value]) => {
      url.searchParams.set(key, value.toString());
    });
    const response = await fetch(url.toString(), {
      method: "GET",
      headers: getHarvestHeaders(config),
    });

    const responseObj = (await response.json()) as HarvestTimeEntriesPage;
    requestMore = responseObj.next_page !== null;
    timeEntries = timeEntries.concat(responseObj.time_entries);
  } while (requestMore);

  return timeEntries;
};

// TODO XXX - currently unused
//
// const updateHarvestTimeEntry = async (
//   { id: harvestId, notes },
//   jiraWorkLog,
//   dryRun,
//   config
// ) => {
//   const url = new URL(`/v2/time_entries/${harvestId}`, HARVEST_API_BASE_URL);
//   const requestBody = {
//     notes: `${notes}\n\n${HARVEST_LOG_STRING}\n${jiraWorkLog.self}`
//   };
//
//   if (dryRun) {
//     console.log(`Harvest PATCH request body for time entry (${harvestId}):\n${JSON.stringify(requestBody, undefined, 2)}`);
//     return;
//   }
//
//   const response = await fetch(url, {
//     method: "PATCH",
//     headers: getHarvestHeaders(config),
//     body: JSON.stringify(requestBody)
//   });
//   if (!response.ok) {
//     console.error(`Cannot update Harvest time entry (${harvestId}) - ${response.statusText}`);
//     console.log(await response.text());
//     return;
//   }
//   console.log(`Successfully updated time entry in Harvest (${harvestId})`);
// }

const getJiraIssue = async (
  jiraKey: string,
  projectConfig: ProjectConfig
): Promise<JiraIssue | null> => {
  const url = new URL(
    `/rest/api/3/issue/${jiraKey}`,
    `https://${projectConfig.atlassianDomain}.atlassian.net`
  );
  const response = await fetch(url.toString(), {
    method: "GET",
    headers: getJiraHeaders(projectConfig),
  });

  if (!response.ok) {
    console.error(
      `Encountered error fetching Jira issue - ${response.statusText}`
    );
    return null;
  }

  return (await response.json()) as JiraIssue;
};

// Given a Jira issue and a harvest ID, looks for a worklog item
// with a comment matching the harvest time entry ID
const hasExistingWorkLog = (
  jiraIssue: JiraIssue,
  harvestId: HarvestTimeEntry["id"]
) => {
  const allComments = (jiraIssue.fields?.worklog?.worklogs ?? [])
    .flatMap((worklog) =>
      worklog.comment?.content?.flatMap((p) =>
        p.content?.flatMap((t) => t.text)
      )
    )
    .filter(<T>(v: T | undefined): v is T => Boolean(v));

  return allComments.some((c) => c.includes(`${harvestId}`));
};

const getUserTimeZone = async (
  projectConfig: ProjectConfig
): Promise<string | null> => {
  assert(projectConfig.jiraProjectKey);
  assert(projectConfig.atlassianAccountEmail);

  const url = new URL(
    `/rest/api/3/user/assignable/multiProjectSearch`,
    `https://${projectConfig.atlassianDomain}.atlassian.net`
  );
  url.searchParams.set("projectKeys", projectConfig.jiraProjectKey);
  url.searchParams.set("query", projectConfig.atlassianAccountEmail);

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: getJiraHeaders(projectConfig),
  });
  if (!response.ok) {
    console.error(
      `Couldn't fetch user's timezone setting - ${response.statusText}`
    );
    return null;
  }

  const [user] = (await response.json()) as Array<JiraUser>;

  if (!user) {
    console.error(`Couldn't fetch user's timezone setting - no matching user`);
    return null;
  }

  return user.timeZone;
};

const logTimeEntryToJira = async (
  jiraKey: string,
  entry: HarvestTimeEntry,
  projectConfig: ProjectConfig,
  dryRun: boolean
) => {
  const { id: harvestId, spent_date, rounded_hours } = entry;
  const userTz = (await getUserTimeZone(projectConfig)) ?? "America/New_York";
  const url = new URL(
    `/rest/api/3/issue/${jiraKey}/worklog`,
    `https://${projectConfig.atlassianDomain}.atlassian.net`
  );
  const startedDate = ZonedDateTime.of(
    LocalDate.parse(spent_date),
    LocalTime.NOON,
    ZoneId.of(userTz)
  );
  const requestBody = {
    timeSpentSeconds: rounded_hours * 60 * 60,
    notifyUsers: false,
    comment: {
      version: 1,
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "emoji",
              attrs: {
                shortName: ":timer:",
                id: "23f2",
              },
            },
            {
              type: "text",
              text: " Harvest time entry ID: ",
            },
            {
              type: "text",
              text: `${harvestId}`,
              marks: [
                {
                  type: "code",
                },
              ],
            },
          ],
        },
      ],
    },
    started: startedDate.format(DateTimeFormatter.ISO_OFFSET_DATE_TIME),
  };

  if (dryRun) {
    console.log(
      `Jira POST body for Harvest time entry (${jiraKey}):\n${JSON.stringify(
        requestBody,
        undefined,
        2
      )}`
    );
    return null;
  }

  const response = await fetch(url.toString(), {
    method: "POST",
    headers: {
      ...getJiraHeaders(projectConfig),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(requestBody),
  });
  if (!response.ok) {
    console.error(
      `Logging Harvest time entry (${harvestId}) to Jira failed - ${response.statusText}`
    );
    return null;
  }
  console.log(`Successfully logged time to ${jiraKey}`);
  return response.json();
};

const logTimeEntriesToJira = async (
  timeEntries: Array<HarvestTimeEntry>,
  config: Config,
  dryRun: boolean
) => {
  for (const entry of timeEntries) {
    const {
      id: harvestId,
      is_closed,
      notes,
      project,
      spent_date,
      user,
    } = entry;

    if (!is_closed) {
      console.log(
        `Skipping Harvest entry from ${spent_date} (${harvestId}) - time entry is not closed`
      );
      continue;
    }

    if (
      config.user &&
      config.user.harvestUserId &&
      config.user.harvestUserId !== user.id
    ) {
      console.log(
        `Skipping Harvest entry from ${spent_date} (${harvestId}) - Harvest user (${user.id}) does not match config`
      );
      continue;
    }

    if (notes && notes.includes(HARVEST_LOG_STRING)) {
      console.log(
        `Skipping Harvest entry from ${spent_date} (${harvestId}) - already logged to Jira`
      );
      continue;
    }

    const projectConfig = (config.projects ?? []).find(
      ({ harvestId: configHarvestId }) => {
        return configHarvestId === project.id;
      }
    );

    if (!projectConfig) {
      console.error(
        `Skipping Harvest entry from ${spent_date} (${harvestId}) - no Jira key maps to Harvest project (${project.id})`
      );
      continue;
    }

    let matches = new Array<string>();
    let match: RegExpMatchArray | null = null;
    const jiraKeyRegex = new RegExp(
      `(${projectConfig.jiraProjectKey}\\-[0-9]+)`,
      "g"
    );
    do {
      match = jiraKeyRegex.exec(notes ?? "");
      if (match && match[0]) {
        matches.push(match[0]);
      }
    } while (match !== null);

    if (matches.length > 1) {
      console.log(
        `Found multiple Jira tickets in Harvest entry from ${spent_date} (${harvestId}) - choosing first`
      );
    }

    const jiraKey = matches.length < 1 ? null : matches[0];

    if (!jiraKey) {
      console.error(
        `Jira key missing from Harvest entry from ${spent_date} (${harvestId}) - skipping`
      );
      continue;
    }

    const jiraIssue = await getJiraIssue(jiraKey, projectConfig);

    if (!jiraIssue) {
      console.error(
        `Could not find issue associated with ${jiraKey} - skipping`
      );
      continue;
    }

    if (!hasExistingWorkLog(jiraIssue, harvestId)) {
      await logTimeEntryToJira(jiraIssue.key, entry, projectConfig, dryRun);
    } else {
      console.log(
        `Found Harvest time entry already associated with ${jiraKey} - skipping Jira update`
      );
    }

    console.log(`✅ Harvest time entry (${harvestId}) done`);
  }
};

(async () => {
  const mostRecentMonday = LocalDate.now().with(
    TemporalAdjusters.previousOrSame(DayOfWeek.MONDAY)
  );

  const responses = await prompts([
    {
      type: "date",
      name: "week",
      message: "Pick the the week you'd like to log",
      initial: convert(mostRecentMonday.atStartOfDay()).toDate(),
      mask: "dddd, MM/DD/YYYY",
      validate: (date) => date < Date.now() || "Cannot be in the future",
    },
    {
      type: "toggle",
      name: "dryRun",
      message: "Dry run?",
      initial: true,
      active: "yes",
      inactive: "no",
    },
    {
      type: "text",
      name: "configFile",
      message: "Path to config file",
      initial: path.resolve(".", CONFIG_DIR, "projects.json"),
    },
  ]);

  let configJson: Config;
  try {
    await fs.access(responses.configFile, constants.R_OK);
    configJson = JSON.parse(await fs.readFile(responses.configFile, "utf-8"));
  } catch (err) {
    throw new Error(`Tried to parse config file but couldn't: ${err}`);
  }

  const [datePart] = responses.week.toISOString().split("T");
  const dateJoda = LocalDate.parse(datePart);

  const sundayBefore = dateJoda.with(
    TemporalAdjusters.previousOrSame(DayOfWeek.SUNDAY)
  );
  const sundayAfter = sundayBefore.plusWeeks(1);

  const timeEntries = await getHarvestTimeEntries(
    sundayBefore.atStartOfDay(),
    sundayAfter.atStartOfDay().minusSeconds(1),
    configJson
  );

  await logTimeEntriesToJira(timeEntries, configJson, responses.dryRun);
})();
