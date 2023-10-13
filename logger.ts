import pino from "pino";

const logger = pino({
  level: process.env.LOG_LEVEL ?? "debug",
  transport: {
    target: "pino-pretty",
  },
});

export default logger;
