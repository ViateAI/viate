import type { FastifyBaseLogger } from "fastify";
import { createPluginLogger, type PluginLogger } from "@viateai/sdk";

export function pluginLoggerFromFastify(logger: FastifyBaseLogger): PluginLogger {
  return createPluginLogger((level, fields, message) => {
    if (fields) {
      logger[level](fields, message);
      return;
    }
    logger[level](message);
  });
}
