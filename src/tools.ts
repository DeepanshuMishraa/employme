import { Effect, Schema } from "effect";
import { Tool, Toolkit } from "effect/unstable/ai";


const UserGithubData = Tool.make("get_github_repository_data", {
  description: "Get the repository data for a user",
  parameters: Schema.Struct({

  }),
  success: Schema.Struct({
  })
});


export const GithubTools = Toolkit.make(UserGithubData);

export const TimeToolLayer = TimeTools.toLayer({
  get_current_time: ({ city }) =>
    Effect.sync(() => {
      const timeZone = timeZoneFor(city);

      try {
        return new Intl.DateTimeFormat(undefined, {
          dateStyle: "medium",
          timeStyle: "short",
          timeZone,
        }).format(new Date());
      } catch {
        return `I don't know the time zone for ${city}. Use a city I recognize or an IANA time zone such as America/New_York.`;
      }
    })
});
