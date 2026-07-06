import { chatWithGemma } from "../src/gemma";

async function main() {
  try {
    console.log("Sending 'hi' to Cathy...");
    const reply1 = await chatWithGemma("hi");
    console.log("Cathy says:", reply1);

    console.log("\nSending 'what do you think of Mark?' to Cathy...");
    const reply2 = await chatWithGemma("what do you think of Mark?");
    console.log("Cathy says:", reply2);
  } catch (err) {
    console.error(err);
  }
}

main();
