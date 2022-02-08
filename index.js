import dotenv from 'dotenv'; 
import { promises as fs, constants } from 'fs';
import path from 'path';
import fetch from 'node-fetch';
import prompts from 'prompts';

const MONDAY_INDEX = 1;
const CONFIG_DIR = "config";
const HARVEST_API_BASE_URL = "https://api.harvestapp.com";

const getHarvestHeaders = () => {
  return {
    "User-Agent": "Node.js API Client",
    "Authorization": `Bearer ${process.env.HARVEST_ACCESS_TOKEN}`,
    "Harvest-Account-ID": process.env.HARVEST_ACCOUNT_ID
  };
}

const getHarvestTimeEntries = async (timeFloor, timeCeiling) => {
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
      headers: getHarvestHeaders()
    });

    const responseObj = await response.json();
    requestMore = responseObj.next_page !== null;
    timeEntries = timeEntries.concat(
      responseObj.time_entries
    );
  } while(requestMore);

  return timeEntries;
};

const logWorkToJira = async (
  timeEntries,
  config,
  dryRun
) => {
  const logItemsByIssue = {};
  for (const entry of timeEntries) {
    const {
      id, // int
      is_closed, // boolean
      notes, // string, e.g. 'FOOBAR-3145 - updated config for Jan API release'
      project, // object, e.g. { id: 31288138, name: 'Portal Q3 FY22' }
      rounded_hours, // int
      spent_date, // string, e.g. '2022-02-02'
      user, // object, e.g. { id: 4043252, name: 'Test Testerson' }
    } = entry;

    if (
      config.user
      && config.user.id
      && config.user.id !== user.id
    ) {
      console.log(`Skipping time entry from ${spent_date} (${id}) - Harvest user (${user.id}) does not match config`)
      continue;
    }

    const projectConfig = (config.projects ?? []).find(({ harvestId }) => {
      return harvestId === project.id;
    });

    if (!projectConfig) {
      console.log(`Skipping time entry from ${spent_date} (${id}) - no Jira key maps to Harvest project (${project.id})`)
      continue;
    }

    const jiraKeyRegex = new RegExp(`(${projectConfig.jiraKey}\\-[0-9]+)`);
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
    sundayAfter
  );

  await logWorkToJira(
    timeEntries,
    configJson,
    responses.dryRun
  );
})();