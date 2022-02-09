import dotenv from 'dotenv'; 
import { promises as fs, constants } from 'fs';
import path from 'path';
import fetch from 'node-fetch';
import prompts from 'prompts';

const MONDAY_INDEX = 1;
const CONFIG_DIR = "config";
const HARVEST_API_BASE_URL = "https://api.harvestapp.com";
const HARVEST_LOG_STRING = "~~~ LOGGED TO JIRA ~~~";
const JIRA_ISSUE_TYPE_EPIC = "Epic";

const getHarvestHeaders = (config) => {
  if (!config.user?.harvestAccessToken || !config.user?.harvestAccountId) {
    throw new Error(["Missing one or both of the following config values: [",
      "\t'user.harvestAccessToken'",
      "\t'user.harvestAccountId'",
      "]"
    ].join("\n"));
  }

  return {
    "User-Agent": "Node.js API Client",
    "Authorization": `Bearer ${config.user.harvestAccessToken}`,
    "Harvest-Account-ID": config.user.harvestAccountId,
    "Content-Type": "application/json"
  };
}

const getHarvestTimeEntries = async (
  timeFloor,
  timeCeiling,
  config
) => {
  let timeEntries = [];

  let requestMore = false;
  let page = 1;

  do {
    const url = new URL("/v2/time_entries", HARVEST_API_BASE_URL);
    const params = {
      page,
      per_page: 100,
      from: timeFloor.toISOString(),
      to: timeCeiling.toISOString(),
    };
    Object.keys(params).forEach((key) => {
      url.searchParams.set(key, params[key]);
    });
    const response = await fetch(url, {
      method: "GET",
      headers: getHarvestHeaders(config)
    });

    const responseObj = await response.json();
    requestMore = responseObj.next_page !== null;
    timeEntries = timeEntries.concat(
      responseObj.time_entries
    );
  } while(requestMore);

  return timeEntries;
};

const updateHarvestTimeEntry = async (
  { id: harvestId, notes },
  jiraWorkLog,
  dryRun,
  config
) => {
  const url = new URL(`/v2/time_entries/${harvestId}`, HARVEST_API_BASE_URL);
  const requestBody = {
    notes: `${notes}\n\n${HARVEST_LOG_STRING}\n${jiraWorkLog.self}` 
  };

  if (!dryRun) {
    const response = await fetch(url, {
      method: "PATCH",
      headers: getHarvestHeaders(config),
      body: JSON.stringify(requestBody)
    });
    if (!response.ok) {
      console.error(`Cannot update Harvest time entry (${harvestId}) - ${response.statusText}`);
      return;
    }
    console.log(`Successfully updated time entry in Harvest (${harvestId})`);
  }

  console.log(`Harvest PATCH request body for time entry (${harvestId}):\n${JSON.stringify(requestBody, undefined, 2)}`);
}

const getJiraHeaders = (projectConfig) => {
  if (!projectConfig.atlassianAccountEmail || !projectConfig.atlassianApiToken) {
    throw new Error(["Missing one or both of the following config values: [",
      "\t'projectConfig.atlassianAccountEmail'",
      "\t'projectConfig.atlassianApiToken'",
      "]"
    ].join("\n"));
  }

  return {
    "Authorization": `Basic ${Buffer.from(
      projectConfig.atlassianAccountEmail + ":" + projectConfig.atlassianApiToken
    ).toString("base64")}`,
    "Accept": "application/json",
    "Content-Type": "application/json"
  };
}

const getJiraIssue = async (
  jiraKeyFromHarvest,
  projectConfig,
  logToEpic
) => {
  let jiraIssue = null;
  let jiraKey = jiraKeyFromHarvest;
  do {
    const url = new URL(
      `/rest/api/3/issue/${jiraKey}`,
      `https://${projectConfig.atlassianDomain}.atlassian.net`
    );
    const response = await fetch(url, {
      method: "GET",
      headers: getJiraHeaders(projectConfig) 
    });

    if (!response.ok) {
      console.error(`Encountered error fetching Jira issue - ${response.statusText}`);
    }

    const data = await response.json();

    const issueType = data?.fields?.issuetype?.name;
    if (!issueType) {
      console.error(`Encountered error fetching Jira issue - could not find issue type for ${jiraKey}`);
      return null;
    }
    if (logToEpic) {
      if (issueType === JIRA_ISSUE_TYPE_EPIC) {
        jiraIssue = data;
      } else {
        if (data.fields?.parent?.key) {
          jiraKey = data.fields.parent.key;
        } else {
          console.log(`Found issue without epic - ${jiraKey} has no parent`)
          jiraIssue = data;
        }
      }
    } else {
      jiraIssue = data;
    }
  } while (jiraIssue === null)

  return jiraIssue;
}

const logTimeEntryToJira = async (
  jiraKey,
  { id: harvestId, rounded_hours, spent_date },
  projectConfig,
  dryRun
) => {
  const url = new URL(
    `/rest/api/3/issue/${jiraKey}/worklog`,
    `https://${projectConfig.atlassianDomain}.atlassian.net`
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
                id: "23f2"
              }
            },
            {
              type: "text",
              text: " Harvest time entry ID: "
            },
            {
              type: "text",
              text: `${harvestId}`,
              marks: [
                {
                  type: "code"
                }
              ]
            }
          ]
        }
      ]
    },
    started: new Date(spent_date).toISOString().replace(/Z$/, "+0000")
  }

  if (!dryRun) {
    const response = await fetch(url, {
      method: "POST",
      headers: getJiraHeaders(projectConfig),
      body: JSON.stringify(requestBody)
    });
    if (!response.ok) {
      console.error(`Logging Harvest time entry (${harvestId}) to Jira failed - ${response.statusText}`)
      return null;
    }
    console.log(`Successfully logged time to ${jiraKey}`);
    return response.json();
  }

  console.log(`Jira POST body for Harvest time entry (${jiraKey}):\n${
    JSON.stringify(requestBody, undefined, 2)
  }`);
  return null;
}

const logTimeEntriesToJira = async (
  timeEntries,
  config,
  logToEpic,
  dryRun
) => {
  for (const entry of timeEntries) {
    const {
      id: harvestId, // int
      is_closed, // boolean
      notes, // string, e.g. 'FOOBAR-3145 - updated config for Jan API release'
      project, // object, e.g. { id: 31288138, name: 'Portal Q3 FY22' }
      spent_date, // string, e.g. '2022-02-02'
      user, // object, e.g. { id: 4043252, name: 'Test Testerson' }
    } = entry;

    if (!is_closed) {
      console.log(`Skipping Harvest entry from ${spent_date} (${harvestId}) - time entry is not closed`);
      continue;
    }

    if (
      config.user
      && config.user.harvestUserId
      && config.user.harvestUserId !== user.id
    ) {
      console.log(`Skipping Harvest entry from ${spent_date} (${harvestId}) - Harvest user (${user.id}) does not match config`);
      continue;
    }

    if (
      notes
      && notes.includes(HARVEST_LOG_STRING)
    ) {
      console.log(`Skipping Harvest entry from ${spent_date} (${harvestId}) - already logged to Jira`);
      continue;
    }

    const projectConfig = (config.projects ?? [])
      .find(({ harvestId: configHarvestId }) => {
        return configHarvestId === project.id;
      });

    if (!projectConfig) {
      console.error(`Skipping Harvest entry from ${spent_date} (${harvestId}) - no Jira key maps to Harvest project (${project.id})`);
      continue;
    }

    let matches = [];
    let match;
    const jiraKeyRegex = new RegExp(`(${projectConfig.jiraProjectKey}\\-[0-9]+)`, "g");
    do {
      match = jiraKeyRegex.exec(notes);
      if (match) {
        matches.push(match[0]);
      }
    } while (match !== null);

    if (matches.length < 1) {
      console.error(`Jira key missing from Harvest entry from ${spent_date} (${harvestId}) - skipping`);
      continue;
    }

    if (matches.length > 1) {
      console.log(`Found multiple Jira tickets in Harvest entry from ${spent_date} (${harvestId}) - choosing first`);
    }

    const jiraKey = matches[0];
    const jiraIssue = await getJiraIssue(
      jiraKey,
      projectConfig,
      logToEpic
    );

    if (!jiraIssue) {
      console.error(`Could not find ${logToEpic ? "epic" : "issue"} associated with ${jiraKey} - skipping`);
      continue;
    }

    const workLog = await logTimeEntryToJira(
      jiraIssue.key,
      entry,
      projectConfig,
      dryRun
    );
    if (workLog) {
      await updateHarvestTimeEntry(
        entry,
        workLog,
        dryRun,
        config
      );
    }
  }
};

(async () => {
  dotenv.config();

  const mostRecentMonday = new Date();
  while (mostRecentMonday.getDay() !== MONDAY_INDEX) {
    mostRecentMonday.setDate(mostRecentMonday.getDate() - 1);
  }
  mostRecentMonday.setHours(0);
  mostRecentMonday.setMinutes(0);
  mostRecentMonday.setSeconds(0);
  mostRecentMonday.setMilliseconds(0);

  const questions = [
    {
      type: "date",
      name: "week",
      message: "Pick the the week you'd like to log",
      initial: mostRecentMonday,
      mask: "dddd, MM/DD/YYYY",
      validate: date => date > Date.now() ? 'Cannot be in the future' : true
    },
    {
      type: "toggle",
      name: "logToEpic",
      message: "Log to epic?",
      initial: true,
      active: "yes",
      inactive: "no"
    },
    {
      type: "toggle",
      name: "dryRun",
      message: "Dry run?",
      initial: true,
      active: "yes",
      inactive: "no"
    },
    {
      type: "text",
      name: "configFile",
      message: "Path to config file",
      initial: path.resolve(".", CONFIG_DIR, "projects.json")
    }
  ];
  const responses = await prompts(questions);

  let configJson;
  try {
    await fs.access(responses.configFile, constants.R_OK);
    configJson = JSON.parse(
      await fs.readFile(responses.configFile, "utf-8")
    );
  } catch (err) {
    throw new Error(`Tried to parse config file but couldn't: ${err}`);
  }

  const sundayBefore = responses.week;
  while (sundayBefore.getDay() !== (MONDAY_INDEX - 1)) {
    sundayBefore.setDate(sundayBefore.getDate() - 1);
  }
  sundayBefore.setHours(0);
  sundayBefore.setMinutes(0);
  sundayBefore.setSeconds(0);
  sundayBefore.setMilliseconds(0);

  const sundayAfter = new Date(sundayBefore.getTime());
  sundayAfter.setDate(sundayAfter.getDate() + 7);
  
  const timeEntries = await getHarvestTimeEntries(
    sundayBefore,
    sundayAfter,
    configJson
  );

  await logTimeEntriesToJira(
    timeEntries,
    configJson,
    responses.logToEpic,
    responses.dryRun
  );
})();