import {
  DateTimeFormatter,
  LocalDate,
  LocalDateTime,
  LocalTime,
  ZoneId,
  ZonedDateTime,
} from "@js-joda/core";
import assert from "assert";
import fetch from "node-fetch";
import { AnyIterable, map, tap } from "streaming-iterables";
import logger from "./logger";
import {
  BaseIterable,
  Config,
  DefinitelyWithJiraIssue,
  DefinitelyWithProjectConfig,
  DefinitelyWithUserTz,
  HarvestTimeEntriesPage,
  HarvestTimeEntry,
  JiraIssue,
  JiraUser,
  JiraWorkLog,
  ProjectConfig,
  WithFullConfig,
  WithJiraIssue,
  WithProjectConfig,
} from "./types";

const HARVEST_API_BASE_URL = "https://api.harvestapp.com";
const JIRA_DATE_TIME_FORMATTER = DateTimeFormatter.ofPattern(
  "yyyy-MM-dd'T'HH:mm:ss.SSSZ"
);
const TZ_AMERICA_NEW_YORK = "America/New_York";

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
        `Running in dry mode - skipping worklog creation on Jira issue (${jiraKey})`,
        requestBody
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
    logger.debug(`Successfully logged time to ${jiraKey}`);
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

    const projectConfig = (config.projects ?? []).find(
      ({ harvestId: configHarvestId }) => {
        return configHarvestId === project.id;
      }
    );
    if (!projectConfig) {
      logger.info(
        `Time entry from ${spent_date} (${harvestId}) associated with unrecognized Harvest project (${project.id})`
      );
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
      logger.debug(
        `Found multiple Jira tickets in Harvest entry from ${spent_date} (${harvestId}) - choosing first`
      );
    }

    let jiraIssue: JiraIssue | undefined = undefined;
    const jiraKey = matches.length < 1 ? null : matches[0];

    if (!jiraKey) {
      logger.warn(
        `Jira key missing from Harvest entry from ${spent_date} (${harvestId})`
      );
    } else {
      jiraIssue = (await getJiraIssue(jiraKey, projectConfig)) ?? undefined;
    }

    if (jiraKey && !jiraIssue) {
      logger.warn(`Could not find issue associated with ${jiraKey}`);
    }

    yield { ...item, jiraIssue };
  }
};

const canLogItemToJira = (item: DefinitelyWithJiraIssue): boolean => {
  const {
    jiraIssue,
    config,
    timeEntry: { id: harvestId, spent_date, is_closed, user },
  } = item;

  if (!is_closed) {
    logger.info(`Time entry from ${spent_date} (${harvestId}) is not closed`);
    return false;
  }
  if (
    config.user &&
    config.user.harvestUserId &&
    config.user.harvestUserId !== user.id
  ) {
    logger.warn(
      `Time entry from ${spent_date} (${harvestId}) associated with unrecognized user (${user.id})`
    );
    return false;
  }
  if (hasExistingWorkLog(jiraIssue, harvestId)) {
    logger.info(
      `Time entry from ${spent_date} (${harvestId}) already logged to ${jiraIssue.key}`
    );
    return false;
  }
  return true;
};

export {
  canLogItemToJira,
  enrichWithJiraIssue,
  enrichWithProjectConfig,
  enrichWithUserTz,
  getHarvestHeaders,
  getHarvestTimeEntries,
  getJiraHeaders,
  getJiraIssue,
  logTimeEntriesToJira,
};
