const args = process.argv.slice(2);

if (args.includes("--version") || args.includes("-version")) {
  console.log("STM32CubeProgrammer version: 2.19.0");
  process.exit(0);
}

console.log("STM32CubeProgrammer command completed without explicit operation result");
process.exit(0);
