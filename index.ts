import {
  DayOfWeek,
  LocalDate,
  TemporalAdjusters,
  convert,
} from "@js-joda/core";
import "@js-joda/timezone"; // required to use ZoneId
import { constants, promises as fs } from "fs";
import path from "path";
import prompts from "prompts";
import { filter, map, pipeline, reduce } from "streaming-iterables";
import logger from "./logger";
import {
  Config,
  DefinitelyWithJiraIssue,
  DefinitelyWithProjectConfig,
  WithJiraIssue,
  WithProjectConfig,
} from "./types";
import {
  canLogItemToJira,
  enrichWithJiraIssue,
  enrichWithJiraWorkLogs,
  enrichWithProjectConfig,
  enrichWithUserTz,
  getHarvestTimeEntries,
  logTimeEntriesToJira,
} from "./util";

const CONFIG_DIR = "config";

const run = async () => {
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

  const logHours = await pipeline(
    () =>
      getHarvestTimeEntries(
        sundayBefore.atStartOfDay(),
        sundayAfter.atStartOfDay().minusSeconds(1),
        configJson
      ),
    enrichWithProjectConfig,
    filter((item: WithProjectConfig): item is DefinitelyWithProjectConfig =>
      Boolean(item.projectConfig)
    ),
    enrichWithUserTz,
    enrichWithJiraIssue,
    filter((item: WithJiraIssue): item is DefinitelyWithJiraIssue =>
      Boolean(item.jiraIssue)
    ),
    enrichWithJiraWorkLogs,
    filter(canLogItemToJira),
    (items) => logTimeEntriesToJira(items, responses.dryRun)
  );

  const totalLoggedHours = await reduce(
    (acc, item) => acc + item.timeEntry.rounded_hours,
    0,
    logHours
  );

  logger.debug(`Logged ${totalLoggedHours.toFixed(2)} hour(s) in total`);
};

if (require.main === module) {
  run();
}
