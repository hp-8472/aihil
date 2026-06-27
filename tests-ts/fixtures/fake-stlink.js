const args = process.argv.slice(2);
const command = args.join(" ");

if (args.includes("--version") || args.includes("-version")) {
  console.log("STM32CubeProgrammer version: 2.19.0");
  process.exit(0);
}

if (args.includes("-c") && !args.includes("-w") && !args.includes("-rst") && !args.includes("-halt")) {
  console.log("ST-LINK SN  : STLINK123");
  console.log("Device name : STM32F446RE");
  process.exit(0);
}

if (args.includes("-c") && args.includes("-w") && args.includes("-v") && args.includes("-rst")) {
  console.log("Download verified successfully");
  process.exit(0);
}

if (args.includes("-c") && (args.includes("-rst") || args.includes("-halt"))) {
  console.log("MCU Reset");
  console.log("Software reset is performed");
  process.exit(0);
}

console.error(`fake STM32_Programmer_CLI command was not recognized: ${command}`);
process.exit(1);
