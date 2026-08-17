import chalk from "chalk";

function ts() {
  return new Date().toLocaleTimeString();
}

export const log = {
  info: (msg) => console.log(`${chalk.gray(ts())} ${msg}`),
  ok: (msg) => console.log(`${chalk.gray(ts())} ${chalk.green("✓")} ${msg}`),
  warn: (msg) => console.log(`${chalk.gray(ts())} ${chalk.yellow("!")} ${msg}`),
  err: (msg) => console.log(`${chalk.gray(ts())} ${chalk.red("✗")} ${msg}`),
  hit: (msg) => console.log(`${chalk.gray(ts())} ${chalk.bgGreen.black(" IN STOCK ")} ${msg}`),
  title: (msg) => console.log(chalk.bold.cyan(`\n${msg}`)),
};
