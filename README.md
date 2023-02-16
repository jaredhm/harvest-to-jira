# harvest-to-jira

Exports time entries from the Harvest timelogging tool to Jira as worklog items.

## Usage

I recommend using [volta](https://docs.volta.sh/guide/getting-started) to manage node versions when using this tool.

Install node dependencies with the following command:

```
npm i
```

Run the tool with:

```
npm start
```

### Run options:
- **week**: input is taken as a date; the tool will then calculate the Sunday-to-Sunday window within which the chosen date falls. This is the date range it'll use for exporting time entries
- **dry run**: when run in "dry" mode, the tool will log Jira worklog items to the console instead of sending them to the Jira API
- **path to config file**: path to your configuration file

### Example configuration file:
```json
{
  "user": {
    "harvestUserId": 1111111, // this can be found in the URL on your Harvest profile page
    "harvestAccessToken": "xxxxxxx.xx.xxxxxxxxx",
    "harvestAccountId": 222222
  },
  "projects": [
    {
      "harvestId": 33333333, // project IDs can be found in the "reports" tab in Harvest
      "jiraProjectKey": "PFMLPB",
      "atlassianDomain": "lwd",
      "atlassianApiToken": "zzzzzzzzzzzzzzzzzzzzzzzz",
      "atlassianAccountEmail":"jared.macfarlane@mass.gov"
    },
    {
      "harvestId": 44444444,
      "jiraProjectKey": "RI",
      "atlassianDomain": "postc-massgov",
      "atlassianApiToken": "yyyyyyyyyyyyyyyyyyyyyyyy",
      "atlassianAccountEmail":"jared@lastcallmedia.com"
    },
  ]
}
```

### Need help? Wanna contribute?
Please don't hesitate to reach out! I wrote this tool for personal use when I was feeling particularly lazy ([the time spent on it so far probably won't pay off](https://xkcd.com/1319/)), so it's a bit rough around the edges.
