// Turns the shared trip password into the value for TRIP_PASSWORD_HASH.
//
//   bun run hash-password
//
// Run it yourself in a terminal. The password is read from the keyboard
// without being shown, is never passed as an argument, and is not stored:
// only the hash is printed. Do not run it through an assistant or paste the
// password into a chat.

import { hashPassword } from "../src/server/password";

function readHidden(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const { stdin, stderr } = process;
    if (!stdin.isTTY) {
      reject(new Error("Run this in an interactive terminal so the password can be typed privately."));
      return;
    }
    stderr.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let value = "";
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === "\r" || char === "\n" || char === "\u0004") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off("data", onData);
          stderr.write("\n");
          resolve(value);
          return;
        }
        if (char === "\u0003") {
          stdin.setRawMode(false);
          stderr.write("\n");
          process.exit(130);
        }
        if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
        else value += char;
      }
    };
    stdin.on("data", onData);
  });
}

const first = await readHidden("Trip password: ");
if (first.length < 12) {
  console.error("Use at least 12 characters. A few unrelated words works well.");
  process.exit(1);
}
const second = await readHidden("Type it again: ");
if (first !== second) {
  console.error("The two entries do not match. Nothing was produced.");
  process.exit(1);
}
console.error("Set this as TRIP_PASSWORD_HASH (it is a one-way hash, not the password):");
console.log(await hashPassword(first));
