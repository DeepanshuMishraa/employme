import { Config, Effect, Stream } from "effect";
import { Spectrum, markdown, typing } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
import { GetLLMResponse } from "./ai-service";

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


  yield* Stream.runForEach(messages, ([space, message]) => {
    const content = message.content;
    if (!("text" in content)) return Effect.void;

    return Effect.gen(function* () {
      const response = yield* GetLLMResponse(content.text);
      yield* Effect.promise(() => space.send(typing()).then(() => {
        typing("stop");
        return space.send(markdown(response));
      }));
    });

  });
});

