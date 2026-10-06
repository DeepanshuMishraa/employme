import { Gmail } from "./gmail";
import { SpectrumService } from "./spectrum";


export async function main() {
  try {
    Gmail.serve();
  } catch (err) {
    console.error("Gmail OAuth server did not start (is OAUTH_PORT in use?). Everything except connecting Gmail still works.", err);
  }
  const spectrum = SpectrumService();
  return spectrum
}

await main()
