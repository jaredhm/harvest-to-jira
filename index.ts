import {
  DateTimeFormatter,
  DayOfWeek,
  LocalDate,
  LocalDateTime,
  LocalTime,
  TemporalAdjusters,
  ZoneId,
  ZonedDateTime,
  convert,
} from "@js-joda/core";
import "@js-joda/timezone"; // required to use ZoneId
import assert from "assert";
import { constants, promises as fs } from "fs";
import fetch from "node-fetch";
import path from "path";
import pino from "pino";
import prompts from "prompts";
import {
  AnyIterable,
  consume,
  filter,
  map,
  pipeline,
  tap,
} from "streaming-iterables";

const logger = pino();
const CONFIG_DIR = "config";
const HARVEST_API_BASE_URL = "https://api.harvestapp.com";
const JIRA_DATE_TIME_FORMATTER = DateTimeFormatter.ofPattern(
  "yyyy-MM-dd'T'HH:mm:ss.SSSZ"
);
const TZ_AMERICA_NEW_YORK = "America/New_York";

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

type TextContent = {
  type: "text";
  text: string;
};
type EmojiContent = {
  type: "emoji";
  attrs: {
    shortName: string;
    id: string;
  };
};
// this API resource may actually be less sparse than
// the interface suggests, but Jira REST can be unreliable
type JiraWorkLog = Partial<{
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

interface JiraIssue {
  key: string;
  fields: Partial<{
    worklog: Partial<{
      worklogs: Array<JiraWorkLog>;
    }>;
  }>;
}

interface BaseIterable {
  timeEntry: HarvestTimeEntry;
}

type WithFullConfig = BaseIterable & {
  config: Config;
};

type ProjectConfigEnrichment = { projectConfig: ProjectConfig };
type WithProjectConfig = WithFullConfig & Partial<ProjectConfigEnrichment>;
type DefinitelyWithProjectConfig = WithFullConfig & ProjectConfigEnrichment;

type UserTzEnrichment = { userTz: string };
type DefinitelyWithUserTz = DefinitelyWithProjectConfig & UserTzEnrichment;

type JiraIssueEnrichment = { jiraIssue: JiraIssue };
type WithJiraIssue = DefinitelyWithUserTz & Partial<JiraIssueEnrichment>;
type DefinitelyWithJiraIssue = DefinitelyWithUserTz & JiraIssueEnrichment;

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

const getHarvestTimeEntries = async function* (
  timeFloor: LocalDateTime,
  timeCeiling: LocalDateTime,
  config: Config
): AsyncIterable<BaseIterable> {
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
    yield* map((timeEntry) => ({ timeEntry }), responseObj.time_entries);
  } while (requestMore);
};

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
    logger.error(
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
        p.content?.flatMap((t) => (t.type === "text" ? t.text : undefined))
      )
    )
    .filter(<T>(v: T | undefined): v is T => Boolean(v));

  return allComments.some((c) => c.includes(`${harvestId}`));
};

const enrichWithUserTz = async function* (
  items: AnyIterable<DefinitelyWithProjectConfig>
): AsyncIterable<DefinitelyWithUserTz> {
  let timezone: JiraUser["timeZone"] | undefined = undefined;

  for await (const item of items) {
    const { projectConfig } = item;
    assert(projectConfig.jiraProjectKey);
    assert(projectConfig.atlassianAccountEmail);

    const url = new URL(
      `/rest/api/3/user/assignable/multiProjectSearch`,
      `https://${projectConfig.atlassianDomain}.atlassian.net`
    );
    url.searchParams.set("projectKeys", projectConfig.jiraProjectKey);
    url.searchParams.set("query", projectConfig.atlassianAccountEmail);

    if (timezone) {
      yield { ...item, userTz: timezone };
    } else {
      const response = await fetch(url.toString(), {
        method: "GET",
        headers: getJiraHeaders(projectConfig),
      });
      if (!response.ok) {
        logger.warn(
          `Couldn't fetch user's timezone setting - ${response.statusText}`
        );
      } else {
        const [user] = (await response.json()) as Array<JiraUser>;

        if (!user) {
          logger.warn(
            `Couldn't fetch user's timezone setting - no matching user`
          );
        } else {
          timezone = user.timeZone;
        }
      }
      yield { ...item, userTz: timezone ?? TZ_AMERICA_NEW_YORK };
    }
  }
};

const logTimeEntriesToJira = function (
  items: AnyIterable<DefinitelyWithJiraIssue>,
  dryRun: boolean
) {
  return tap(async (item) => {
    const {
      timeEntry: { id: harvestId, spent_date, rounded_hours },
      projectConfig,
      jiraIssue: { key: jiraKey },
      userTz,
    } = item;
    const url = new URL(
      `/rest/api/3/issue/${jiraKey}/worklog`,
      `https://${projectConfig.atlassianDomain}.atlassian.net`
    );
    const startedDate = ZonedDateTime.of(
      LocalDate.parse(spent_date),
      LocalTime.NOON,
      ZoneId.of(userTz)
    );
    const requestBody: JiraWorkLog = {
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
                text: `Harvest time entry ID: ${harvestId}`,
              },
            ],
          },
        ],
      },
      started: startedDate.format(JIRA_DATE_TIME_FORMATTER),
    };

    if (dryRun) {
      logger.debug(
        `Jira POST body for Harvest time entry (${jiraKey}):\n${JSON.stringify(
          requestBody,
          undefined,
          2
        )}`
      );
      return;
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
      logger.error(
        `Logging Harvest time entry (${harvestId}) to Jira failed - ${response.statusText}`
      );
      return;
    }
    logger.info(`Successfully logged time to ${jiraKey}`);
  }, items);
};

const enrichWithProjectConfig = async function* (
  items: AnyIterable<WithFullConfig>
): AsyncIterable<WithProjectConfig | DefinitelyWithProjectConfig> {
  for await (const item of items) {
    const {
      timeEntry: { id: harvestId, is_closed, project, spent_date, user },
      config,
    } = item;
    let warning: string | undefined = undefined;

    if (!is_closed) {
      warning = `Time entry from ${spent_date} (${harvestId}) is not closed`;
    }

    if (
      config.user &&
      config.user.harvestUserId &&
      config.user.harvestUserId !== user.id
    ) {
      warning = `Time entry from ${spent_date} (${harvestId}) associated with unrecognized user (${user.id})`;
    }

    const projectConfig = (config.projects ?? []).find(
      ({ harvestId: configHarvestId }) => {
        return configHarvestId === project.id;
      }
    );

    if (!projectConfig) {
      warning = `Time entry from ${spent_date} (${harvestId}) associated with unrecognized Harvest project (${project.id})`;
    }

    if (warning) {
      logger.warn(warning);
    }

    yield { ...item, projectConfig };
  }
};

const enrichWithJiraIssue = async function* (
  items: AnyIterable<DefinitelyWithUserTz>
): AsyncIterable<WithJiraIssue> {
  for await (const item of items) {
    const {
      timeEntry: { id: harvestId, notes, spent_date },
      projectConfig,
    } = item;

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
      logger.info(
        `Found multiple Jira tickets in Harvest entry from ${spent_date} (${harvestId}) - choosing first`
      );
    }

    let jiraIssue: JiraIssue | undefined = undefined;
    let warning: string | undefined = undefined;
    const jiraKey = matches.length < 1 ? null : matches[0];

    if (!jiraKey) {
      warning = `Jira key missing from Harvest entry from ${spent_date} (${harvestId})`;
    } else {
      jiraIssue = (await getJiraIssue(jiraKey, projectConfig)) ?? undefined;
    }

    if (!jiraIssue) {
      warning = `Could not find issue associated with ${jiraKey}`;
    }

    if (warning) {
      logger.warn(warning);
    }

    yield { ...item, jiraIssue };
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

  await pipeline(
    () =>
      getHarvestTimeEntries(
        sundayBefore.atStartOfDay(),
        sundayAfter.atStartOfDay().minusSeconds(1),
        configJson
      ),
    map((item) => ({ ...item, config: configJson })),
    enrichWithProjectConfig,
    filter((item: WithProjectConfig): item is DefinitelyWithProjectConfig =>
      Boolean(item.projectConfig)
    ),
    enrichWithUserTz,
    enrichWithJiraIssue,
    filter((item: WithJiraIssue): item is DefinitelyWithJiraIssue =>
      Boolean(item.jiraIssue)
    ),
    filter((item: DefinitelyWithJiraIssue) => {
      const {
        jiraIssue,
        timeEntry: { id: harvestId, spent_date },
      } = item;
      if (hasExistingWorkLog(jiraIssue, harvestId)) {
        logger.warn(
          `Time entry from ${spent_date} (${harvestId}) already logged to ${jiraIssue.key}`
        );
        return false;
      }
      return true;
    }),
    (items) => logTimeEntriesToJira(items, responses.dryRun),
    consume
  );
})();
