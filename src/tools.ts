import { tool } from "ai";
import { Effect, Schema } from "effect";
import { GetDateTimeSchema } from "./schema";

export const GetDateTime = tool({
  description: "Get the current date and time for the user's city",
  inputSchema: Schema.toStandardSchemaV1(GetDateTimeSchema),
  execute: ({ city }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const time = new Date().toLocaleTimeString(city);
        return {
          output: `The current time in ${city} is ${time}.`
        };
      })
    )
});
