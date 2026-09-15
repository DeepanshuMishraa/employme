import { Effect } from "effect";


const program: Effect.Effect<String> = Effect.succeed("Hello World");

console.log(Effect.runSync(program))
