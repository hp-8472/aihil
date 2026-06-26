const args = process.argv.slice(2);

if (args.includes("--version")) {
  console.log("Open On-Chip Debugger 0.12.0 fake");
  process.exit(0);
}

const commandIndex = args.lastIndexOf("-c");
const command = commandIndex >= 0 ? args[commandIndex + 1] ?? "" : "";

if (command.includes("AIHIL_RESULT:probe_target:ok")) {
  console.log("AIHIL_RESULT:probe_target:ok");
  process.exit(0);
}

if (command.includes("AIHIL_RESULT:flash_firmware:ok")) {
  console.log("AIHIL_RESULT:flash_firmware:ok");
  process.exit(0);
}

if (command.includes("AIHIL_RESULT:reset_target:ok")) {
  console.log("AIHIL_RESULT:reset_target:ok");
  process.exit(0);
}

console.error("fake OpenOCD command was not recognized");
process.exit(1);
