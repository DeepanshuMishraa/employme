import { Console, Effect } from "effect";
import { SpectrumService } from "./spectrum";


const program = Effect.gen(function* () {
  yield* Console.log("Service Is Up");
  const spectrum = yield* SpectrumService;

  return spectrum;
});


await Effect.runPromise(program);
