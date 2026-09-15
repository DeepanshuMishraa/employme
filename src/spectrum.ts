import { Config, Effect, Stream } from "effect";
import { Spectrum } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";

export const SpectrumService = Effect.gen(function* () {
  const projectId = yield* Config.String("SPECTRUM_PROJECT_ID");
  const projectSecret = yield* Config.String("SPECTRUM_PROJECT_SECRET");

  const app = yield* Effect.tryPromise({
    try: () =>
      Spectrum({
        projectId,
        projectSecret,
        providers: [imessage.config()]
      }),
    catch: (cause) => new Error("Could not initialize Spectrum", { cause })

  });


  const messages = Stream.fromAsyncIterable(app.messages, (cause) => new Error("Message Stream Failed", { cause }));


  yield* messages.pipe(
    Stream.runForEach(([space, message]) => {
      const content = message.content;
      if (!("text" in content)) return Effect.void;

      return Effect.promise(() => space.send(content.text).then(() => undefined));
    }),
  );
});

