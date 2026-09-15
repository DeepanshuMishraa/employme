import { Effect, Schema } from "effect";
import { Tool, Toolkit } from "effect/unstable/ai";


const GetCurrentTime = Tool.make("get_current_time", {
  description: "Get the current time for a city or IANA time zone",
  parameters: Schema.Struct({
    city: Schema.String
  }),
  success: Schema.String,
});

const CITY_TIME_ZONES: Record<string, string> = {
  "new york": "America/New_York",
  "new york city": "America/New_York",
  london: "Europe/London",
  paris: "Europe/Paris",
  tokyo: "Asia/Tokyo",
  "san francisco": "America/Los_Angeles",
};

const timeZoneFor = (city: string) =>
  CITY_TIME_ZONES[city.trim().toLowerCase()] ?? city.trim();

export const TimeTools = Toolkit.make(GetCurrentTime);


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
